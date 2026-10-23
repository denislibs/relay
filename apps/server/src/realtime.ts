import type { Server } from 'bun';
import type { ServerFrame } from '@relay/protocol';
import { sql } from './db';
import type { UpdatesNotify } from './domain/journal';
import { processAlive, processGone } from './domain/liveRegistry';
import { closeLive, parseEnded, terminatedFrame, touchLive } from './domain/sessions';

const POKE = JSON.stringify({ op: 'poke' });

// dev (/dev/stats): задержка NOTIFY — pg_notify на своём канале и время до его прихода в LISTEN этого процесса
const PING_CHANNEL = 'dev_ping';
const pings = new Map<string, () => void>();
let pingSub: Promise<unknown> | null = null;

/** Один круг pg_notify → LISTEN, мс (≈ путь журнал → poke); null — не дождались за timeoutMs. */
export async function notifyLatency(timeoutMs = 2000): Promise<number | null> {
  pingSub ??= sql.listen(PING_CHANNEL, (token) => { pings.get(token)?.(); }).catch((e) => { pingSub = null; throw e; });
  await pingSub;
  const token = crypto.randomUUID();
  const t0 = performance.now();
  const got = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { pings.delete(token); resolve(null); }, timeoutMs);
    pings.set(token, () => { clearTimeout(timer); pings.delete(token); resolve(Math.round((performance.now() - t0) * 10) / 10); });
  });
  await sql`select pg_notify(${PING_CHANNEL}, ${token})`;
  return got;
}

/** Будит сокеты пользователей, чьи журналы изменились в любом процессе сервера. */
export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  await processAlive();   // до первого сокета: иначе его счётчик не попадёт в сумму
  // каждые 30 с: процесс жив (ключ на 90 с) — иначе его счётчики онлайна не учитываются
  const alive = setInterval(() => { processAlive().catch((e) => console.error('live registry:', e)); }, 30_000);
  alive.unref?.();
  const sub = await sql.listen('updates', (payload) => {
    let n: UpdatesNotify;
    try { n = JSON.parse(payload); } catch { return; }
    if (Array.isArray(n)) { for (const id of n) server.publish(`user:${id}`, POKE); return; }
    for (const id of n.p) server.publish(`user:${id}`, POKE);
    // событие с seq получателя — в сокет сразу; клиент сверит seq и при расхождении синхронизируется сам
    for (const [id, seq] of n.u) server.publish(`user:${id}`, JSON.stringify({ op: 'push', from: seq - 1, to: seq, items: [{ seq, update: n.e }] } satisfies ServerFrame));
  });
  // завершённые сеансы (в любом процессе): кадр в топик сеанса, затем сокеты этого процесса закрываются
  const subSessions = await sql.listen('sessions', (payload) => {
    const ended = parseEnded(payload);
    if (!ended) return;
    for (const id of ended.ids) { server.publish(`session:${id}`, terminatedFrame(ended.reason)); closeLive(id); }
  });
  // раз в минуту: активность всех открытых сокетов и страховка на потерянный NOTIFY (сеанс пропал — сокет закрываем)
  const timer = setInterval(() => {
    touchLive().catch((e) => console.error('sessions touch:', e));
  }, 60_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer); clearInterval(alive);
    await sub.unlisten(); await subSessions.unlisten();
    await processGone().catch(() => {});
  };
}
