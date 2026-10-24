import { normalizeEntities, type Entity, type JournalEntry, type MyMembership, type Update } from '@relay/protocol';
import { beforeCommit, isTx, onCommit, sql, type Tx } from '../db';
import { DomainError } from './errors';
import { toMessage } from './chats';
import { openDrafts, openRows } from './messageContent';

export const MAX_BATCH = 500;

/**
 * Журналы пишутся в момент коммита (db.ts beforeCommit), одним запросом каждый, всегда в порядке
 * «журналы чатов (по возрастанию chat_id) → личные (по возрастанию user_id)». Так замки счётчиков живут от
 * flushJournals до коммита, а порядок замков один для всех транзакций — дедлоков между параллельными
 * транзакциями нет. Тело транзакции только копит записи: chatEvent / appendUpdates / membershipEvent.
 *
 * После коммита (db.ts onCommit): на каждый чат — один NOTIFY 'chat_updates' со всеми его событиями этой
 * транзакции (если помещаются в 8000 байт); для личных — один NOTIFY 'updates' (notifyPayloads).
 */
type Written = { userId: number; seq: number; update: Update };
type Entry = { userId: number; update: Update };
type PerTx = {
  chats: Map<number, Update[]>;
  users: Entry[];
  memberships: { userId: number; chatId: number; me: MyMembership }[];
  chatRanges: Map<number, { from: number; to: number; updates: Update[] }>;   // после flush: для membership.seq и NOTIFY
  written: Written[];                                                         // личные записи после flush: для NOTIFY
  usersFlushed: boolean;                                                      // личный журнал уже писался: chatEvent после этого запрещён (порядок замков)
};
const perTx = new WeakMap<object, PerTx>();
/** Предел полезной нагрузки pg_notify — 8000 байт; длинное сообщение уходит обычным «пинком». */
const NOTIFY_MAX = 7800;

function txState(tx: Tx): PerTx {
  let st = perTx.get(tx);
  if (st) return st;
  if (!isTx(tx)) throw new Error('journal: not a transaction');
  st = { chats: new Map(), users: [], memberships: [], chatRanges: new Map(), written: [], usersFlushed: false };
  perTx.set(tx, st);
  const state = st;
  beforeCommit(tx, () => flushJournals(tx));
  onCommit(tx, async () => {
    for (const [chatId, r] of state.chatRanges) await sql`select pg_notify('chat_updates', ${chatNotifyPayload(chatId, r)})`;
    for (const n of notifyPayloads(state.written)) await sql`select pg_notify('updates', ${n})`;
  });
  return st;
}

/** NOTIFY 'chat_updates': {c, f, t, e?} — e: события транзакции, если влезают; иначе клиент сделает syncChat. */
export type ChatNotify = { c: number; f: number; t: number; e?: Update[] };
function chatNotifyPayload(chatId: number, r: { from: number; to: number; updates: Update[] }): string {
  const rich = JSON.stringify({ c: chatId, f: r.from, t: r.to, e: r.updates } satisfies ChatNotify);
  return Buffer.byteLength(rich) <= NOTIFY_MAX ? rich : JSON.stringify({ c: chatId, f: r.from, t: r.to } satisfies ChatNotify);
}

/**
 * Событие чата — в журнал по виду чата: личный → в личные журналы участников (как было), группа/канал → в журнал
 * чата одной записью. kind передавать, где он известен (groupCtx, строка чата) — иначе лишний select.
 */
export async function chatEvent(tx: Tx, chatId: number, update: Update, kind?: 'direct' | 'group' | 'channel'): Promise<void> {
  const st = txState(tx);
  if (!kind) {
    const [c] = await tx`select kind from chats where id = ${chatId}`;
    if (!c) throw new DomainError('not_found', 'chat');
    kind = c.kind as 'direct' | 'group' | 'channel';
  }
  if (kind === 'direct') {
    const members = (await tx`select user_id from chat_members where chat_id = ${chatId}`).map((r) => Number(r.user_id));
    for (const userId of members) st.users.push({ userId, update });
    return;
  }
  if (st.usersFlushed) throw new Error('journal: chatEvent after the personal journal was flushed (lock order)');
  const list = st.chats.get(chatId) ?? [];
  list.push(update);
  st.chats.set(chatId, list);
}

/** Личные записи — копятся до коммита. Вне транзакции (тесты, скрипты): сразу, с NOTIFY. */
export async function appendUpdates(tx: Tx, entries: Entry[]): Promise<void> {
  if (!entries.length) return;
  if (!isTx(tx)) {
    const written = await writeUserEntries(tx, entries);
    for (const n of notifyPayloads(written)) await tx`select pg_notify('updates', ${n})`;
    return;
  }
  txState(tx).users.push(...entries);
}

/** Вступление: membership с seq чата на момент коммита — клиент заводит чат и ничего не догоняет. */
export function membershipEvent(tx: Tx, userId: number, chatId: number, me: MyMembership): void {
  txState(tx).memberships.push({ userId, chatId, me });
}

/**
 * Записать накопленное: журналы чатов, затем личный. Повторяемый — хук перед коммитом допишет то, что добавили
 * после явного вызова (selfSeq читает свой seq внутри транзакции).
 */
export async function flushJournals(tx: Tx): Promise<void> {
  const st = perTx.get(tx);
  if (!st) return;
  for (const chatId of [...st.chats.keys()].sort((a, b) => a - b)) {
    const updates = st.chats.get(chatId)!;
    const n = updates.length;
    const rows = await tx`
      with s as (
        insert into chat_seq (chat_id, seq, updated_at) values (${chatId}, ${n}, clock_timestamp())
        on conflict (chat_id) do update set seq = chat_seq.seq + ${n}, updated_at = clock_timestamp()
        returning seq)
      insert into chat_updates (chat_id, seq, type, payload)
      select ${chatId}, s.seq - ${n} + t.ord, t.type, t.payload::jsonb
        from s, unnest(${updates.map((u) => u.type)}::text[], ${updates.map((u) => JSON.stringify(stored(u)))}::text[]) with ordinality as t(type, payload, ord)
      returning seq`;
    const to = Math.max(...rows.map((r) => Number(r.seq)));
    const prev = st.chatRanges.get(chatId);
    st.chatRanges.set(chatId, { from: prev ? prev.from : to - n, to, updates: [...(prev?.updates ?? []), ...updates] });
  }
  st.chats.clear();
  for (const m of st.memberships) {
    let seq = st.chatRanges.get(m.chatId)?.to;
    if (seq == null) { const [r] = await tx`select seq from chat_seq where chat_id = ${m.chatId}`; seq = r ? Number(r.seq) : 0; }
    st.users.push({ userId: m.userId, update: { type: 'membership', chatId: m.chatId, me: m.me, seq } });
  }
  st.memberships = [];
  if (st.users.length) {
    const entries = st.users; st.users = [];
    st.written.push(...await writeUserEntries(tx, entries));
    st.usersFlushed = true;
  }
}

/**
 * Личный журнал одним запросом: счётчики user_seq поднимаются в порядке возрастания user_id, записи получают
 * последовательные seq в порядке entries. Строки user_seq заперты до коммита: seq у пользователя становятся
 * видимы по порядку и без дыр.
 */
async function writeUserEntries(tx: Tx, entries: Entry[]): Promise<Written[]> {
  const ids = entries.map((e) => e.userId), types = entries.map((e) => e.update.type), payloads = entries.map((e) => JSON.stringify(stored(e.update)));
  const rows = await tx`
    with w as (
      select user_id, type, payload::jsonb as payload, ord, row_number() over (partition by user_id order by ord) as rn,
             count(*) over (partition by user_id) as n
        from unnest(${ids}::bigint[], ${types}::text[], ${payloads}::text[]) with ordinality as t(user_id, type, payload, ord)),
    s as (
      insert into user_seq (user_id, seq)
      select user_id, n from (select distinct user_id, n from w) d order by user_id
      on conflict (user_id) do update set seq = user_seq.seq + excluded.seq
      returning user_id, seq)
    insert into updates (user_id, seq, type, payload)
    select w.user_id, s.seq - w.n + w.rn, w.type, w.payload from w join s using (user_id)
    returning user_id, seq`;
  const byUser = new Map<number, number[]>();
  for (const r of rows) { const l = byUser.get(r.user_id as number) ?? []; l.push(r.seq as number); byUser.set(r.user_id as number, l); }
  for (const l of byUser.values()) l.sort((a, b) => a - b);
  const next = new Map<number, number>();
  return entries.map((e) => { const i = next.get(e.userId) ?? 0; next.set(e.userId, i + 1); return { userId: e.userId, seq: byUser.get(e.userId)![i], update: e.update }; });
}

export type UpdatesNotify = number[] | { p: number[]; u: [number, number][]; e?: Update; s?: [number, number][]; x?: [number, number][] };

/**
 * Содержимое NOTIFY 'updates' по записям одной транзакции: p — пинок, u — получают e сразу (ровно одна запись
 * newMessage у них в этой транзакции), s/x — подписать/отписать сокеты пользователя на журнал чата (membership /
 * chatRemoved). Полезная нагрузка pg_notify не больше 8000 байт, а получателей бывают тысячи: режем на части,
 * e повторяется в каждой; каждый получатель — ровно в одной.
 */
export function notifyPayloads(written: Written[]): string[] {
  if (!written.length) return [];
  const count = new Map<number, number>();
  for (const w of written) count.set(w.userId, (count.get(w.userId) ?? 0) + 1);
  const all = [...count.keys()];
  const subs = written.filter((w) => w.update.type === 'membership').map((w) => `[${w.userId},${(w.update as { chatId: number }).chatId}]`);
  const unsubs = written.filter((w) => w.update.type === 'chatRemoved').map((w) => `[${w.userId},${(w.update as { chatId: number }).chatId}]`);
  // одно и то же newMessage (один объект) у тех, кому в этой транзакции записали только его
  const inline = written.filter((w) => w.update.type === 'newMessage' && count.get(w.userId) === 1);
  const e = inline[0]?.update;
  const withE = !!e && !inline.some((w) => w.update !== e);
  const eJson = withE ? JSON.stringify(e) : '';
  const u = new Set(withE ? inline.map((w) => w.userId) : []);
  const head = 40 + Buffer.byteLength(eJson);   // {"p":[],"u":[],"s":[],"x":[],"e":…}
  const pokes = all.filter((id) => !u.has(id)).map((id) => String(id));
  const pairs = withE && head <= NOTIFY_MAX ? inline.map((w) => `[${w.userId},${w.seq}]`) : [];
  if (withE && head > NOTIFY_MAX) for (const w of inline) pokes.push(String(w.userId));   // длинное сообщение — всем пинок
  const out: string[] = [];
  type Part = { p: string[]; u: string[]; s: string[]; x: string[] };
  let cur: Part = { p: [], u: [], s: [], x: [] }, size = head;
  const flush = () => {
    if (!cur.p.length && !cur.u.length && !cur.s.length && !cur.x.length) return;
    out.push(`{"p":[${cur.p.join(',')}],"u":[${cur.u.join(',')}],"s":[${cur.s.join(',')}],"x":[${cur.x.join(',')}]${cur.u.length ? `,"e":${eJson}` : ''}}`);
    cur = { p: [], u: [], s: [], x: [] }; size = head;
  };
  const add = (k: keyof Part, v: string) => { if (size + v.length + 1 > NOTIFY_MAX) flush(); cur[k].push(v); size += v.length + 1; };
  for (const v of pokes) add('p', v);
  for (const v of subs) add('s', v);
  for (const v of unsubs) add('x', v);
  for (const v of pairs) add('u', v);
  flush();
  return out;
}

/**
 * Журнал хранит ссылки, а не тексты: события о сообщении — только {chatId, id}, черновик — только {chatId, at}.
 * Тело подставляет чтение (getUpdates) из messages/drafts — одно место правды вместо копии у каждого участника:
 * в группе на 200 человек текст лежал 200 раз, а удалённое сообщение оставалось в журнале. Клиент получает прежний
 * формат: подстановка — на сервере, при отдаче.
 */
export type Stored = Update | { type: MessageRef; chatId: number; id: number; ref: 1 } | { type: 'mention'; chatId: number; id: number; threadId?: number; ref: 1 } | { type: 'draft'; chatId: number; at: string; ref: 1 };
type MessageRef = 'newMessage' | 'messageEdited' | 'messageMarkup' | 'todoUpdated' | 'linkPreview' | 'attachmentUpdated';

export function stored(u: Update): Stored {
  switch (u.type) {
    case 'newMessage': return { type: u.type, chatId: u.message.chatId, id: u.message.id, ref: 1 };
    case 'messageEdited': case 'messageMarkup': case 'todoUpdated': case 'linkPreview': case 'attachmentUpdated':
      return { type: u.type, chatId: u.chatId, id: u.id, ref: 1 };
    case 'draft': return { type: 'draft', chatId: u.chatId, at: u.at, ref: 1 };
    case 'mention': return { type: 'mention', chatId: u.message.chatId, id: u.message.id, ...(u.threadId != null ? { threadId: u.threadId } : {}), ref: 1 };
    default: return u;
  }
}

/** Ссылки журнала → полные события: сообщения одним запросом, черновики — вторым. Сообщения уже нет — «удалено». */
export async function hydrate(userId: number | null, rows: { seq: number; payload: Stored }[]): Promise<JournalEntry[]> {
  const refs = rows.filter((r) => 'ref' in r.payload && r.payload.type !== 'draft') as { payload: { chatId: number; id: number } }[];
  const drafts = rows.filter((r) => 'ref' in r.payload && r.payload.type === 'draft') as { payload: { chatId: number } }[];
  const byKey = new Map<string, Record<string, unknown>>();
  if (refs.length) {
    const msgs = await openRows(await sql`
      select * from messages
       where (chat_id, id) in (select * from unnest(${refs.map((r) => r.payload.chatId)}::bigint[], ${refs.map((r) => r.payload.id)}::bigint[]))`);
    for (const m of msgs) byKey.set(m.chat_id + ':' + m.id, m);
  }
  const draftBy = new Map<number, Record<string, unknown>>();
  if (drafts.length && userId != null) {
    const ds = await openDrafts(await sql`select user_id, chat_id, text, entities, content, updated_at from drafts where user_id = ${userId} and chat_id = any(${[...new Set(drafts.map((d) => d.payload.chatId))]}::bigint[])`);
    for (const d of ds) draftBy.set(Number(d.chat_id), d);
  }
  const out = rows.map(({ seq, payload: p }): JournalEntry => {
    if (!('ref' in p)) return { seq, update: p };
    if (p.type === 'draft') {
      const d = draftBy.get(p.chatId);
      const text = (d?.text as string | undefined) ?? '';
      const entities = text ? normalizeEntities(text, d?.entities as Entity[] | undefined) : [];
      return { seq, update: { type: 'draft', chatId: p.chatId, text, at: d ? new Date(d.updated_at as string).toISOString() : p.at, ...(entities.length ? { entities } : {}) } };
    }
    const row = byKey.get(p.chatId + ':' + p.id);
    // строки нет (чат удалён целиком) — «удалено»; удалённое сообщение — то же событие с пустым содержимым, за ним в журнале messageDeleted
    if (!row) return { seq, update: { type: 'messageDeleted', chatId: p.chatId, id: p.id } };
    const m = toMessage(row);
    switch (p.type) {
      case 'newMessage': return { seq, update: { type: 'newMessage', message: m } };   // реакции — своими событиями, как и раньше
      // упоминание удалённого — удаление (счётчик «@» у клиента уходит вместе с ним)
      case 'mention': return row.deleted ? { seq, update: { type: 'messageDeleted', chatId: p.chatId, id: p.id } } : { seq, update: { type: 'mention', message: m, ...(p.threadId != null ? { threadId: p.threadId } : {}) } };
      case 'messageEdited': return { seq, update: { type: 'messageEdited', chatId: p.chatId, id: p.id, body: m.body, editedAt: m.editedAt ?? m.createdAt, entities: m.entities ?? [] } };
      case 'messageMarkup': return { seq, update: { type: 'messageMarkup', chatId: p.chatId, id: p.id, body: m.body, ...(m.entities ? { entities: m.entities } : {}), buttons: m.buttons ?? null } };
      case 'todoUpdated': return m.todo ? { seq, update: { type: 'todoUpdated', chatId: p.chatId, id: p.id, todo: m.todo, ...(m.editedAt ? { editedAt: m.editedAt } : {}) } } : { seq, update: { type: 'messageDeleted', chatId: p.chatId, id: p.id } };
      case 'linkPreview': return { seq, update: { type: 'linkPreview', chatId: p.chatId, id: p.id, link: m.link ?? null } };
      case 'attachmentUpdated': return m.attachment ? { seq, update: { type: 'attachmentUpdated', chatId: p.chatId, id: p.id, attachment: m.attachment } } : { seq, update: { type: 'messageDeleted', chatId: p.chatId, id: p.id } };
    }
  });
  return out;
}

export async function fanOut(tx: Tx, userIds: number[], update: Update): Promise<void> {
  await appendUpdates(tx, [...new Set(userIds)].map((userId) => ({ userId, update })));
}

export async function currentSeq(userId: number): Promise<number> {
  const [row] = await sql`select seq from user_seq where user_id = ${userId}`;
  return row ? (row.seq as number) : 0;
}

export async function getUpdates(userId: number, since: number, limit = Number(process.env.RELAY_SYNC_BATCH) || MAX_BATCH) {
  const seq = await currentSeq(userId);
  if (since >= seq) return { items: [] as JournalEntry[], seq, more: false, tooLong: false };
  const [first] = await sql`select min(seq) as min from updates where user_id = ${userId}`;
  // журнал почищен целиком (min = null) или дальше, чем since: клиенту нужен снимок
  if (first.min === null || since < (first.min as number) - 1) return { items: [] as JournalEntry[], seq, more: false, tooLong: true };
  const rows = await sql`select seq, payload from updates where user_id = ${userId} and seq > ${since} order by seq limit ${limit}`;
  const items = await hydrate(userId, rows.map((r) => ({ seq: r.seq as number, payload: r.payload as Stored })));
  const last = items.length ? items[items.length - 1].seq : since;
  return { items, seq, more: last < seq, tooLong: false };
}

/** dev (/dev/stats): seq пользователя, сколько записей журнала у него хранится и с какой начинается (дальше — tooLong). */
export async function journalStats(userId: number): Promise<{ seq: number; size: number; minSeq: number | null }> {
  const [[s], [j]] = await Promise.all([
    sql`select seq from user_seq where user_id = ${userId}`,
    sql`select count(*)::int as size, min(seq) as min from updates where user_id = ${userId}`,
  ]);
  return { seq: s ? (s.seq as number) : 0, size: j.size as number, minSeq: j.min == null ? null : Number(j.min) };
}
