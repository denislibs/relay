import type { Server } from 'bun';
import { sql } from './db';
import { closeLive, TERMINATED_FRAME } from './domain/sessions';

const POKE = JSON.stringify({ op: 'poke' });

/** Будит сокеты пользователей, чьи журналы изменились в любом процессе сервера. */
export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  const sub = await sql.listen('updates', (payload) => {
    let users: number[];
    try { users = JSON.parse(payload); } catch { return; }
    for (const id of users) server.publish(`user:${id}`, POKE);
  });
  // завершённые сеансы (в любом процессе): кадр в топик сеанса, затем сокеты этого процесса закрываются
  const subSessions = await sql.listen('sessions', (payload) => {
    let ids: number[];
    try { ids = JSON.parse(payload); } catch { return; }
    for (const id of ids) { server.publish(`session:${id}`, TERMINATED_FRAME); closeLive(id); }
  });
  return async () => { await sub.unlisten(); await subSessions.unlisten(); };
}
