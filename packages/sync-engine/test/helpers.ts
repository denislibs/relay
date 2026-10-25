import { resetChatKeyCache } from '../../../apps/server/src/crypto/chatKeys';
import { openRows } from '../../../apps/server/src/domain/messageContent';
import { sql } from '../../../apps/server/src/db';
import { processAlive } from '../../../apps/server/src/domain/liveRegistry';
import { flushOwn } from '../../../apps/server/src/valkey';
import { resetPresence } from '../../../apps/server/src/domain/presence';
import { createServer } from '../../../apps/server/src/http';
import { startRealtime } from '../../../apps/server/src/realtime';
import { Engine } from '../src/engine';
import type { EngineConfig, Patch, Query, Item } from '../src/types';
export { msg } from './fixtures';

export async function resetDb(): Promise<void> {
  resetChatKeyCache();   // номера чатов после truncate начинаются заново — старые ключи в памяти не к ним
  await flushOwn();   // онлайн и прочее эфемерное прошлых тестов
  await processAlive();   // ключ «процесс жив» стёрт вместе с остальным — серверы этого процесса снова в сумме онлайна
  // как resetDb сервера: системного пользователя «Relay» (миграция 110_service) не трогаем — база общая с тестами сервера
  await sql`truncate login_attempts, sessions, chats, chat_members, messages, user_seq, updates, jobs, jobs_dead restart identity cascade`;
  await sql`delete from users where not system`;
  // поиск — по Postgres, пока тест сам не построит индекс (meili.test.ts)
  await sql`delete from server_meta where k in ('search_index', 'search_building', 'search_reindex_after')`;
  await sql`insert into users (name, system) select 'Relay', true where not exists (select 1 from users where system)`;
  resetPresence(); // присутствие прошлых тестов не должно протекать
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
    async unreadReactions(token: string, chatId: number) {
      const res = await fetch(`${base}/chats/${chatId}/reactions/unread`, { headers: { cookie: `relay_session=${token}` } });
      return (await res.json()) as { ids: number[]; count: number };
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
  const list = () => order.map((k) => items.get(k)!).filter((i) => i && !i.key.startsWith('~')); // служебные элементы (~window) — не данные
  return {
    handle, patches, list,
    item: (key: string) => items.get(key),   // и служебные (~window, ~thread)
    async until(pred: (l: Item[]) => boolean, ms = 3000): Promise<Item[]> {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(list())) return list(); await Bun.sleep(5); }
      throw new Error('timeout; last state: ' + JSON.stringify(list()));
    },
  };
}

/** Строки messages, как их видит сервер: содержимое — из шифра. */
export const opened = <T extends Record<string, unknown>>(rows: T[]): Promise<T[]> => openRows(rows);
