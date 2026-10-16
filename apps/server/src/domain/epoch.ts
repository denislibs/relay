import { sql } from '../db';

/** Поколение базы. Читается на каждом hello: seed --reset в другом процессе меняет его на лету. */
export async function currentEpoch(): Promise<string> {
  const [row] = await sql`select v from server_meta where k = 'epoch'`;
  return (row?.v as string) ?? 'none';
}

/** Новое поколение: старые кэши клиентов становятся недействительными. */
export async function bumpEpoch(): Promise<string> {
  const [row] = await sql`
    insert into server_meta (k, v) values ('epoch', md5(random()::text || clock_timestamp()::text))
    on conflict (k) do update set v = excluded.v returning v`;
  return row.v as string;
}
