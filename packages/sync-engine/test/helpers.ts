import { sql } from '../../../apps/server/src/db';
import { createServer } from '../../../apps/server/src/http';
import { startRealtime } from '../../../apps/server/src/realtime';
import { Engine } from '../src/engine';
import type { EngineConfig, Patch, Query, Item } from '../src/types';
export { msg } from './fixtures';

export async function resetDb(): Promise<void> {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}

export async function startTestServer() {
  const server = createServer({ port: 0 });
  const stop = await startRealtime(server);
  const base = `http://localhost:${server.port}`;
  return {
    base,
    async login(name: string) {
      const res = await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) });
      return (await res.json()) as { userId: number; token: string };
    },
    async chat(token: string, memberIds: number[]) {
      const res = await fetch(`${base}/dev/chats`, { method: 'POST', headers: { cookie: `relay_session=${token}` }, body: JSON.stringify({ kind: memberIds.length > 2 ? 'group' : 'direct', title: null, memberIds }) });
      return ((await res.json()) as { id: number }).id;
    },
    config(user: { userId: number; token: string }, dbName = 'db-' + crypto.randomUUID()): EngineConfig {
      return {
        userId: user.userId, dbName, httpBase: base,
        wsUrl: `ws://localhost:${server.port}/ws?token=${user.token}`,
        headers: { cookie: `relay_session=${user.token}` },
        frameMs: 5, readFlushMs: 30, backoffMs: [20, 200],
      };
    },
    async stop() { await stop(); server.stop(true); },
  };
}

/** Собирает патчи подписки в зеркало и даёт ждать нужного состояния. */
export function watchInto(engine: Engine, q: Query) {
  const items = new Map<string, Item>();
  let order: string[] = [];
  const patches: Patch[] = [];
  const handle = engine.watch(q, (p) => {
    patches.push(p);
    if (p.op === 'snapshot') { items.clear(); for (const it of p.items) items.set(it.key, it); order = p.order; }
    else { for (const k of p.remove) items.delete(k); for (const it of p.upsert) items.set(it.key, it); if (p.order) order = p.order; }
  });
  const list = () => order.map((k) => items.get(k)!).filter(Boolean);
  return {
    handle, patches, list,
    async until(pred: (l: Item[]) => boolean, ms = 3000): Promise<Item[]> {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(list())) return list(); await Bun.sleep(5); }
      throw new Error('timeout; last state: ' + JSON.stringify(list()));
    },
  };
}
