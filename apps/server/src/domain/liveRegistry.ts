import { sql } from '../db';

/**
 * Кто онлайн — для любого процесса (воркер решает, слать ли push). Строка на (процесс, пользователь);
 * пишется только на переходах 0↔1 соединений, не на каждый сокет. Упавший процесс: его строки
 * отсекаются по seen_at (heartbeat раз в минуту). Закрытие: left_at + пауза — перезагрузка вкладки не «уход».
 */
export const PROCESS_ID = crypto.randomUUID();
// строка без heartbeat дольше 3 минут — процесс упал
const graceSec = () => Number(process.env.RELAY_PRESENCE_GRACE_MS ?? 4000) / 1000;

export async function markOnline(userId: number, conns: number): Promise<void> {
  await sql`
    insert into live_conns (process_id, user_id, conns, left_at, seen_at) values (${PROCESS_ID}, ${userId}, ${conns}, null, now())
    on conflict (process_id, user_id) do update set conns = excluded.conns, left_at = null, seen_at = now()`;
}

export async function markOffline(userId: number): Promise<void> {
  await sql`update live_conns set conns = 0, left_at = now(), seen_at = now() where process_id = ${PROCESS_ID} and user_id = ${userId}`;
}

/** Раз в минуту (realtime.ts): свои строки живы; чужие протухшие и давно закрытые — удалить. */
export async function heartbeat(): Promise<void> {
  await sql`update live_conns set seen_at = now() where process_id = ${PROCESS_ID}`;
  await sql`delete from live_conns where seen_at < now() - interval '3 minutes' or (conns = 0 and left_at < now() - interval '1 minute')`;
}

export async function onlineUsers(userIds: number[]): Promise<Set<number>> {
  if (!userIds.length) return new Set();
  const rows = await sql`
    select distinct user_id from live_conns
     where user_id = any(${userIds}::bigint[])
       and seen_at > now() - interval '3 minutes'
       and (conns > 0 or left_at > now() - make_interval(secs => ${graceSec()}))`;
  return new Set(rows.map((r) => Number(r.user_id)));
}
