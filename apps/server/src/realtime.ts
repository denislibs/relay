import type { Server } from 'bun';
import type { JournalEntry, ServerFrame } from '@relay/protocol';
import { sql } from './db';
import type { ChatNotify, UpdatesNotify } from './domain/journal';
import { getChatUpdatesRange } from './domain/chatJournal';
import { subscribeUserSockets, unsubscribeUserSockets } from './sockets';
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
  // журнал чата: один кадр на всех подписчиков чата в этом процессе (кадр у всех одинаковый — номер общий)
  const publishChat = (c: number, from: number, to: number, items: JournalEntry[]) =>
    server.publish(`chat:${c}`, JSON.stringify({ op: 'push', chatId: c, from, to, items } satisfies ServerFrame));
  // длинное событие (без e — не влезло в 8000 байт): записи читаются один раз на процесс, а не syncChat каждого сокета.
  // Пока чтение в полёте, следующие NOTIFY этого чата встают за ним — push уходят по порядку seq
  const chatQueues = new Map<number, Promise<void>>();
  const subChats = await sql.listen('chat_updates', (payload) => {
    let n: ChatNotify;
    try { n = JSON.parse(payload); } catch { return; }
    const queued = chatQueues.get(n.c);
    if (n.e && !queued) {   // быстрый путь — синхронно, как раньше
      publishChat(n.c, n.f, n.t, n.e.map((update, i) => ({ seq: n.f + 1 + i, update })));
      return;
    }
    const step = async () => {
      if (n.e) { publishChat(n.c, n.f, n.t, n.e.map((update, i) => ({ seq: n.f + 1 + i, update }))); return; }
      const items = await getChatUpdatesRange(n.c, n.f, n.t).catch((e) => { console.error('chat_updates range:', e); return null; });
      // не прочитали (или записей больше пачки) — пустой push: клиенты догонят чат сами (syncChat)
      publishChat(n.c, n.f, n.t, items && items.length === n.t - n.f ? items : []);
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
