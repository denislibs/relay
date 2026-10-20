import { normalizeEntities, type Entity, type JournalEntry, type Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { toMessage } from './chats';
import { openDrafts, openRows } from './messageContent';

export const MAX_BATCH = 500;

/** Пишет по одной записи журнала на каждый элемент. Блокирует user_seq в порядке возрастания user_id — без дедлоков между параллельными транзакциями. */
export async function appendUpdates(tx: Tx, entries: { userId: number; update: Update }[]): Promise<void> {
  const sorted = [...entries].sort((x, y) => x.userId - y.userId);
  const users = new Set<number>();
  for (const { userId, update } of sorted) {
    const [row] = await tx`
      insert into user_seq (user_id, seq) values (${userId}, 1)
      on conflict (user_id) do update set seq = user_seq.seq + 1
      returning seq`;
    await tx`insert into updates (user_id, seq, type, payload) values (${userId}, ${row.seq}, ${update.type}, ${tx.json(stored(update) as never)})`;
    users.add(userId);
  }
  // уведомление уйдёт только после коммита
  if (users.size) await tx`select pg_notify('updates', ${JSON.stringify([...users])})`;
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

export function fanOut(tx: Tx, userIds: number[], update: Update): Promise<void> {
  return appendUpdates(tx, [...new Set(userIds)].map((userId) => ({ userId, update })));
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
