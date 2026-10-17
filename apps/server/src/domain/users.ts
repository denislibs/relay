import { sql } from '../db';

/** Имена людей по id — только тех, с кем у спрашивающего есть общий чат (и его самого). */
export async function usersByIds(userId: number, ids: number[]): Promise<{ id: number; name: string }[]> {
  const want = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!want.length) return [];
  const rows = await sql`
    select u.id, u.name from users u
    where u.id in ${sql(want)} and (u.id = ${userId} or exists (
      select 1 from chat_members m join chat_members o on o.chat_id = m.chat_id
      where m.user_id = ${userId} and o.user_id = u.id))`;
  return rows.map((r) => ({ id: r.id as number, name: r.name as string }));
}
