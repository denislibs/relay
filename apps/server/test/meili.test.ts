import { expect, test } from 'bun:test';
import { indexName, meili, MeiliError, waitTask } from '../src/search/meili';

test('client talks to Meilisearch with the master key; errors carry status and code', async () => {
  expect((await meili<{ status: string }>('/health')).status).toBe('available');
  const name = indexName('probe');
  expect(name).toBe('relay_test_probe');
  const t = await meili<{ taskUid: number }>('/indexes', { method: 'POST', body: { uid: name, primaryKey: 'id' } });
  await waitTask(t.taskUid);
  const err = await meili('/indexes/does_not_exist').catch((e) => e);
  expect(err).toBeInstanceOf(MeiliError);
  expect(err).toMatchObject({ status: 404, code: 'index_not_found' });
  await waitTask((await meili<{ taskUid: number }>(`/indexes/${name}`, { method: 'DELETE' })).taskUid);
});
