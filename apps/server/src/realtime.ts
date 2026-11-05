import type { Server } from 'bun';
import type { JournalEntry, ServerFrame, Update } from '@relay/protocol';
import { sql } from './db';
import type { ChatNotify, UpdatesNotify } from './domain/journal';
import { getChatUpdatesRange } from './domain/chatJournal';
import { recheckThreads, subscribeUserSockets, threadTopic, unsubscribeUserSockets, watchedThreads } from './sockets';
import { processAlive, processGone } from './domain/liveRegistry';
import { closeLive, parseEnded, terminatedFrame, touchLive } from './domain/sessions';

const POKE = JSON.stringify({ op: 'poke' });

// dev (/dev/stats): задержка NOTIFY — pg_notify на своём канале и время до его прихода в LISTEN этого процесса
const PING_CHANNEL = 'dev_ping';
const pings = new Map<string, () => void>();
let pingSub: Promise<unknown> | null = null;

/** Один круг pg_notify → LISTEN, мс (≈ путь журнал → poke); null — не дождались за timeoutMs. */
export async function notifyLatency(timeoutMs = 2000): Promise<number | null> {
  pingSub ??= sql.listen(PING_CHANNEL, (token) => { pings.get(token)?.(); }).catch((e) => { pingSub = null; throw e; });
  await pingSub;
  const token = crypto.randomUUID();
  const t0 = performance.now();
  const got = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { pings.delete(token); resolve(null); }, timeoutMs);
    pings.set(token, () => { clearTimeout(timer); pings.delete(token); resolve(Math.round((performance.now() - t0) * 10) / 10); });
  });
  await sql`select pg_notify(${PING_CHANNEL}, ${token})`;
  return got;
}

/**
 * События push группы, относящиеся к открытым гостями тредам (sockets.ts watchThread): тред → его события. Новое
 * сообщение знает свой тред само (threadId; шапка — сама копия); правка, удаление, реакции, превью — по id, одним
 * запросом на push (O(событий), только если у чата есть гости); информация группы (groupUpdated) — всем тредам.
 * Прочее (состав, закрепы) гостю не нужно. items null — push пустой («догоните сами»): гостям тоже пустой кадр, они перечитают край треда.
 */
export async function threadSlices(chatId: number, watched: ReadonlyMap<number, number>, items: JournalEntry[] | null): Promise<Map<number, Update[]>> {
  const out = new Map<number, Update[]>();
  if (!items) { for (const t of watched.keys()) out.set(t, []); return out; }
  const add = (t: number | null | undefined, u: Update) => { if (t != null && watched.has(t)) { let l = out.get(t); if (!l) out.set(t, (l = [])); l.push(u); } };
  const ask = new Set<number>();
  for (const { update: u } of items) {
    if (u.type === 'newMessage') continue;
    const id = (u as { id?: unknown }).id;
    if ((u as { chatId?: unknown }).chatId === chatId && typeof id === 'number') ask.add(id);
  }
  const threadOf = new Map<number, number>();
  if (ask.size) {
    for (const r of await sql`select id, thread_id from messages where chat_id = ${chatId} and id = any(${[...ask]}::bigint[])`) {
      threadOf.set(Number(r.id), r.thread_id == null ? Number(r.id) : Number(r.thread_id));   // без треда — может быть сама копия (шапка)
    }
  }
  for (const { update: u } of items) {
    if (u.type === 'groupUpdated') { for (const t of watched.keys()) add(t, u); continue; }   // «только участники», заявки, название — гостю тоже
    if (u.type === 'newMessage') add(u.message.threadId ?? u.message.id, u);
    else if (threadOf.has((u as { id?: number }).id!)) add(threadOf.get((u as { id: number }).id), u);
  }
  return out;
}

/** Будит сокеты пользователей, чьи журналы изменились в любом процессе сервера. */
export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  await processAlive();   // до первого сокета: иначе его счётчик не попадёт в сумму
  // каждые 30 с: процесс жив (ключ на 90 с) — иначе его счётчики онлайна не учитываются
  const alive = setInterval(() => { processAlive().catch((e) => console.error('live registry:', e)); }, 30_000);
  alive.unref?.();
  const sub = await sql.listen('updates', (payload) => {
    let n: UpdatesNotify;
    try { n = JSON.parse(payload); } catch { return; }
    if (Array.isArray(n)) { for (const id of n) server.publish(`user:${id}`, POKE); return; }
    // вступил / исключён — подписки сокетов этого процесса на журнал чата, до пинка: следующий push чата не должен пройти мимо
    for (const [uid, chatId] of n.s ?? []) subscribeUserSockets(uid, chatId);
    for (const [uid, chatId] of n.x ?? []) unsubscribeUserSockets(uid, chatId);
    for (const id of n.p) server.publish(`user:${id}`, POKE);
    // событие с seq получателя — в сокет сразу; клиент сверит seq и при расхождении синхронизируется сам
    if (n.e) for (const [id, seq] of n.u) server.publish(`user:${id}`, JSON.stringify({ op: 'push', from: seq - 1, to: seq, items: [{ seq, update: n.e }] } satisfies ServerFrame));
  });
  // гости тредов (не участники группы): свой кадр на тред, по порядку push чата — очередь на чат, как у длинных событий
  const threadQueues = new Map<number, Promise<void>>();
  const publishThreads = (c: number, items: JournalEntry[] | null) => {
    if (!watchedThreads(c)) return;
    const next: Promise<void> = (threadQueues.get(c) ?? Promise.resolve()).then(async () => {
      const watched = watchedThreads(c);
      if (!watched) return;
      for (const [t, list] of await threadSlices(c, watched, items)) {
        server.publish(threadTopic(c, t), JSON.stringify({ op: 'threadPush', chatId: c, threadId: t, items: list } satisfies ServerFrame));
      }
    }).catch((e) => { console.error('thread push:', e); })
      .finally(() => { if (threadQueues.get(c) === next) threadQueues.delete(c); });
    threadQueues.set(c, next);
  };
  // журнал чата: один кадр на всех подписчиков чата в этом процессе (кадр у всех одинаковый — номер общий)
  const publishChat = (c: number, from: number, to: number, items: JournalEntry[]) => {
    server.publish(`chat:${c}`, JSON.stringify({ op: 'push', chatId: c, from, to, items } satisfies ServerFrame));
    publishThreads(c, items.length || from === to ? items : null);
    // перепривязка группы обсуждения и прочие перемены чата — треды гостей перепроверяются (доступ мог пропасть)
    if (items.some((it) => it.update.type === 'groupUpdated')) void recheckThreads(c);
  };
  // длинное событие (без e — не влезло в 8000 байт): записи читаются один раз на процесс, а не syncChat каждого сокета.
  // Пока чтение в полёте, следующие NOTIFY этого чата встают за ним — push уходят по порядку seq
  const chatQueues = new Map<number, Promise<void>>();
  /**
   * Скрытая история (AUTHZ-4): push в chat:<id> один на всех, а у участников разные history_from. Событие с содержимым
   * (правка, реакции, чек-лист, превью…) о сообщении ниже чьей-то границы публиковать нельзя — вместо пачки уходит
   * пустой push, и каждый клиент догоняет чат через syncChat, где сервер фильтрует для него (getChatUpdates).
   */
  const refOf = (u: JournalEntry['update']): number | null =>
    u.type === 'newMessage' || u.type === 'messageDeleted' || u.type === 'pins' ? null : 'id' in u && typeof u.id === 'number' ? u.id : null;
  const hidesAny = async (c: number, items: JournalEntry[]): Promise<boolean> => {
    const ids = items.map((it) => refOf(it.update)).filter((x): x is number => x != null);
    if (!ids.length) return false;
    const [r] = await sql`select coalesce(max(history_from), 0) as h from chat_members where chat_id = ${c}`;
    return Math.min(...ids) < Number(r.h);
  };
  const subChats = await sql.listen('chat_updates', (payload) => {
    let n: ChatNotify;
    try { n = JSON.parse(payload); } catch { return; }
    // чат удалён: всем в топике — push с gone, клиенты убирают чат сами (без syncChat)
    if (n.g) { server.publish(`chat:${n.c}`, JSON.stringify({ op: 'push', chatId: n.c, from: n.f, to: n.t, items: [], gone: true } satisfies ServerFrame)); return; }
    const queued = chatQueues.get(n.c);
    const inline = n.e?.map((update, i) => ({ seq: n.f + 1 + i, update }));
    // быстрый путь — синхронно, как раньше; события о старых сообщениях — через очередь с проверкой скрытой истории
    if (inline && !queued && !inline.some((it) => refOf(it.update) != null)) {
      publishChat(n.c, n.f, n.t, inline);
      return;
    }
    const step = async () => {
      const items = inline ?? await getChatUpdatesRange(n.c, n.f, n.t).catch((e) => { console.error('chat_updates range:', e); return null; });
      // не прочитали, записей больше пачки или кому-то это скрытая история — пустой push: клиенты догонят чат сами (syncChat)
      const whole = items && items.length === n.t - n.f ? items : null;
      const hidden = whole ? await hidesAny(n.c, whole).catch(() => true) : false;
      publishChat(n.c, n.f, n.t, whole && !hidden ? whole : []);
    };
    const next: Promise<void> = (queued ?? Promise.resolve()).then(step).catch((e) => { console.error('chat_updates:', e); })
      .finally(() => { if (chatQueues.get(n.c) === next) chatQueues.delete(n.c); });
    chatQueues.set(n.c, next);
  });
  // завершённые сеансы (в любом процессе): кадр в топик сеанса, затем сокеты этого процесса закрываются
  const subSessions = await sql.listen('sessions', (payload) => {
    const ended = parseEnded(payload);
    if (!ended) return;
    for (const id of ended.ids) { server.publish(`session:${id}`, terminatedFrame(ended.reason)); closeLive(id); }
  });
  // раз в минуту: активность всех открытых сокетов и страховка на потерянный NOTIFY (сеанс пропал — сокет закрываем)
  const timer = setInterval(() => {
    touchLive().catch((e) => console.error('sessions touch:', e));
  }, 60_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer); clearInterval(alive);
    await sub.unlisten(); await subChats.unlisten(); await subSessions.unlisten();
    await processGone().catch(() => {});
  };
}
