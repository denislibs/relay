// Пересчёт списка из 1000 чатов на неизменной базе: только подписи из версий строк, без новых элементов.
// Структурно это проверяет test/queries.test.ts (счётчики); здесь — время, вне bun test (на общих раннерах оно скачет).
// Запуск: docker compose --profile test run --rm test-engine bun bench/chatlist.bench.ts
import 'fake-indexeddb/auto';
import { openDb } from '../src/idb';
import { computeQuery } from '../src/queries';
import { Store } from '../src/store';
import { msg } from '../test/fixtures';

/** Лучшее из runs время computeQuery(chatList) на неизменной базе из n чатов, мс. */
export async function measureChatList(n = 1000, runs = 20): Promise<number> {
  const db = await openDb('bench-' + crypto.randomUUID());
  const s = await Store.open(db, 1);
  s.applySnapshot(Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, kind: 'direct' as const, title: null, lastReadId: 0, unread: 0,
    last: msg({ id: i + 1, chatId: 1000 + i, senderId: 3000 + i }), peer: { id: 3000 + i, name: 'U' + i },
  })));
  const q = { kind: 'chatList' as const, limit: 2 * n };
  computeQuery(s, q);   // первый проход строит элементы
  let best = Infinity;
  for (let k = 0; k < runs; k++) { const t0 = performance.now(); computeQuery(s, q); best = Math.min(best, performance.now() - t0); }
  db.close();
  return best;
}

if (import.meta.main) {
  const best = await measureChatList();
  console.log(`chatList×1000, неизменная база: best ${best.toFixed(3)} ms (цель < 2 ms)`);
  if (best >= 2) process.exitCode = 1;
}
