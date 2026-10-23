import { normalizeEntities, type Entity, type JournalEntry, type Update } from '@relay/protocol';
import { onCommit, sql, type Tx } from '../db';
import { toMessage } from './chats';
import { openDrafts, openRows } from './messageContent';

export const MAX_BATCH = 500;

/**
 * Журнал за одну транзакцию: что кому записали. После коммита уходит один NOTIFY 'updates' (db.ts onCommit):
 * получателям ровно одной записи newMessage — само событие с его seq (сервер отдаёт его в сокет без чтения базы,
 * клиент применяет, если seq следующий за его lastSeq), остальным — «пинок» на обычную синхронизацию.
 */
type Written = { userId: number; seq: number; update: Update };
const perTx = new WeakMap<object, Written[]>();
/** Предел полезной нагрузки pg_notify — 8000 байт; длинное сообщение уходит обычным «пинком». */
const NOTIFY_MAX = 7800;

export type UpdatesNotify = number[] | { p: number[]; u: [number, number][]; e: Update };

/** Содержимое NOTIFY 'updates' по записям одной транзакции: массив — пинок всем; объект — p пинок, u получают e сразу. */
export function notifyPayload(written: Written[]): string {
  const count = new Map<number, number>();
  for (const w of written) count.set(w.userId, (count.get(w.userId) ?? 0) + 1);
  const all = [...count.keys()];
  const plain = JSON.stringify(all);
  // одно и то же newMessage (один объект) у тех, кому в этой транзакции записали только его
  const inline = written.filter((w) => w.update.type === 'newMessage' && count.get(w.userId) === 1);
  const e = inline[0]?.update;
  if (!e || inline.some((w) => w.update !== e)) return plain;
  const u = new Set(inline.map((w) => w.userId));
  const rich = JSON.stringify({ p: all.filter((id) => !u.has(id)), u: inline.map((w) => [w.userId, w.seq]), e } satisfies UpdatesNotify);
  return Buffer.byteLength(rich) <= NOTIFY_MAX ? rich : plain;
}

/**
 * Пишет по одной записи журнала на каждый элемент — одним запросом: счётчики user_seq поднимаются в порядке
 * возрастания user_id (как и прежде — без дедлоков между параллельными транзакциями), записи получают
 * последовательные seq в порядке entries. Строки user_seq заперты до коммита: так seq у пользователя становятся
 * видимы по порядку и без дыр. Возвращает seq каждой записи в порядке entries.
 */
export async function appendUpdates(tx: Tx, entries: { userId: number; update: Update }[]): Promise<number[]> {
  if (!entries.length) return [];
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
  // seq по записям: у пользователя — по порядку его записей в entries
  const byUser = new Map<number, number[]>();
  for (const r of rows) { const l = byUser.get(r.user_id as number) ?? []; l.push(r.seq as number); byUser.set(r.user_id as number, l); }
  for (const l of byUser.values()) l.sort((a, b) => a - b);
  const next = new Map<number, number>();
  const seqs = entries.map((e) => { const i = next.get(e.userId) ?? 0; next.set(e.userId, i + 1); return byUser.get(e.userId)![i]; });

  let written = perTx.get(tx);
  if (!written) {
    written = [];
    perTx.set(tx, written);
    const w = written;
    // уведомление — после коммита, одним NOTIFY на транзакцию (db.ts: почему не внутри)
    if (!onCommit(tx, async () => { await sql`select pg_notify('updates', ${notifyPayload(w)})`; })) {
      perTx.delete(tx);
      await tx`select pg_notify('updates', ${JSON.stringify([...new Set(ids)])})`;   // не транзакция (тесты): как раньше
      return seqs;
    }
  }
  entries.forEach((e, i) => written!.push({ userId: e.userId, seq: seqs[i], update: e.update }));
  return seqs;
}

/**
 * Журнал хранит ссылки, а не тексты: события о сообщении — только {chatId, id}, черновик — только {chatId, at}.
 * Тело подставляет чтение (getUpdates) из messages/drafts — одно место правды вместо копии у каждого участника:
 * в группе на 200 человек текст лежал 200 раз, а удалённое сообщение оставалось в журнале. Клиент получает прежний
 * формат: подстановка — на сервере, при отдаче.
 */
type Stored = Update | { type: MessageRef; chatId: number; id: number; ref: 1 } | { type: 'draft'; chatId: number; at: string; ref: 1 };
type MessageRef = 'newMessage' | 'messageEdited' | 'messageMarkup' | 'todoUpdated' | 'linkPreview' | 'attachmentUpdated';

export function stored(u: Update): Stored {
  switch (u.type) {
    case 'newMessage': return { type: u.type, chatId: u.message.chatId, id: u.message.id, ref: 1 };
    case 'messageEdited': case 'messageMarkup': case 'todoUpdated': case 'linkPreview': case 'attachmentUpdated':
      return { type: u.type, chatId: u.chatId, id: u.id, ref: 1 };
    case 'draft': return { type: 'draft', chatId: u.chatId, at: u.at, ref: 1 };
    default: return u;
  }
}

/** Ссылки журнала → полные события: сообщения одним запросом, черновики — вторым. Сообщения уже нет — «удалено». */
async function hydrate(userId: number, rows: { seq: number; payload: Stored }[]): Promise<JournalEntry[]> {
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
  if (drafts.length) {
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
