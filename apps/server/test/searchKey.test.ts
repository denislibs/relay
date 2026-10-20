import { afterAll, expect, test } from 'bun:test';
import { meili, MeiliError } from '../src/search/meili';

// ключ «только поиск» для процесса server (docker-compose.secure.yml): ищет, но не пишет и не меняет настройки
const UID = '6f1b0c52-5e2a-4c1e-9a7d-0000000000b2';
const INDEX = 'relay_test_keycheck';
afterAll(async () => {
  await meili(`/keys/${UID}`, { method: 'DELETE' }).catch(() => {});
  await meili(`/indexes/${INDEX}`, { method: 'DELETE' }).catch(() => {});
});

test('a search-only key can search the index but cannot write to it', async () => {
  const key = await meili<{ key: string }>(`/keys/${UID}`).catch(() => null)
    ?? await meili<{ key: string }>('/keys', { method: 'POST', body: { uid: UID, actions: ['search'], indexes: ['*'], expiresAt: null } });
  await meili(`/indexes`, { method: 'POST', body: { uid: INDEX, primaryKey: 'id' } }).catch(() => {});
  const as = async (path: string, body: unknown) => {
    const prev = process.env.MEILI_API_KEY;
    process.env.MEILI_API_KEY = key.key;
    try { return await meili(path, { method: 'POST', body }); } finally { if (prev == null) delete process.env.MEILI_API_KEY; else process.env.MEILI_API_KEY = prev; }
  };
  for (let i = 0; i < 50; i++) { try { await as(`/indexes/${INDEX}/search`, { q: 'x' }); break; } catch { await Bun.sleep(100); } }
  expect(await as(`/indexes/${INDEX}/search`, { q: 'x' })).toMatchObject({ hits: [] });
  await expect(as(`/indexes/${INDEX}/documents`, [{ id: 1, body: 'секрет' }])).rejects.toBeInstanceOf(MeiliError);
  await expect(as('/indexes', { uid: 'relay_test_evil' })).rejects.toMatchObject({ status: 403 });
});
