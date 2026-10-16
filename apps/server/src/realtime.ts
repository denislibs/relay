import type { Server } from 'bun';
import { sql } from './db';

const POKE = JSON.stringify({ op: 'poke' });

/** Будит сокеты пользователей, чьи журналы изменились в любом процессе сервера. */
export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  const sub = await sql.listen('updates', (payload) => {
    let users: number[];
    try { users = JSON.parse(payload); } catch { return; }
    for (const id of users) server.publish(`user:${id}`, POKE);
  });
  return () => sub.unlisten();
}
