import type { JournalEntry, Update } from '@relay/protocol';
import { sql, type Tx } from '../db';

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
    await tx`insert into updates (user_id, seq, type, payload) values (${userId}, ${row.seq}, ${update.type}, ${tx.json(update as never)})`;
    users.add(userId);
  }
  // уведомление уйдёт только после коммита
  if (users.size) await tx`select pg_notify('updates', ${JSON.stringify([...users])})`;
}

export function fanOut(tx: Tx, userIds: number[], update: Update): Promise<void> {
  return appendUpdates(tx, [...new Set(userIds)].map((userId) => ({ userId, update })));
}

export async function currentSeq(userId: number): Promise<number> {
  const [row] = await sql`select seq from user_seq where user_id = ${userId}`;
  return row ? (row.seq as number) : 0;
}

export async function getUpdates(userId: number, since: number, limit = MAX_BATCH) {
  const seq = await currentSeq(userId);
  if (since >= seq) return { items: [] as JournalEntry[], seq, more: false, tooLong: false };
  const [first] = await sql`select min(seq) as min from updates where user_id = ${userId}`;
  // журнал почищен целиком (min = null) или дальше, чем since: клиенту нужен снимок
  if (first.min === null || since < (first.min as number) - 1) return { items: [] as JournalEntry[], seq, more: false, tooLong: true };
  const rows = await sql`select seq, payload from updates where user_id = ${userId} and seq > ${since} order by seq limit ${limit}`;
  const items: JournalEntry[] = rows.map((r) => ({ seq: r.seq as number, update: r.payload as Update }));
  const last = items.length ? items[items.length - 1].seq : since;
  return { items, seq, more: last < seq, tooLong: false };
}
