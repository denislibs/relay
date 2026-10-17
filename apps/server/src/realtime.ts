import type { Server } from 'bun';
import { sql } from './db';
import { closeLive, parseEnded, terminatedFrame, touchLive } from './domain/sessions';

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
    const ended = parseEnded(payload);
    if (!ended) return;
    for (const id of ended.ids) { server.publish(`session:${id}`, terminatedFrame(ended.reason)); closeLive(id); }
  });
  // раз в минуту: активность всех открытых сокетов и страховка на потерянный NOTIFY (сеанс пропал — сокет закрываем)
  const timer = setInterval(() => { touchLive().catch((e) => console.error('sessions touch:', e)); }, 60_000);
  timer.unref?.();
  return async () => { clearInterval(timer); await sub.unlisten(); await subSessions.unlisten(); };
}
