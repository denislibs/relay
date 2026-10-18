import { afterAll, beforeEach, expect, test } from 'bun:test';
import { getUpdates } from '../src/domain/journal';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);

type U = { userId: number; token: string };
const login = async (name: string): Promise<U> => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as U;
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { cookie: `relay_session=${u.token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const folder = (over: object = {}) => ({ title: 'Работа', emoji: '💼', include: [10, 11], exclude: [], contacts: false, nonContacts: false, groups: true, excludeMuted: false, excludeRead: false, ...over });

test('create, edit and delete a folder; every real change lands in the journal as settingsChanged', async () => {
  const a = await login('Анна');
  expect((await (await call(a, 'GET', '/settings')).json()).folders).toEqual([]);

  const r = await call(a, 'PUT', '/settings/folders/2', folder());
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.folders).toEqual([{ id: 2, ...folder() }]);
  expect(j.seq).toBe(1);

  // повтор того же — без записи в журнал
  expect((await (await call(a, 'PUT', '/settings/folders/2', folder())).json()).seq).toBe(1);
  // чат в обоих списках остаётся только во включённых
  const edited = await (await call(a, 'PUT', '/settings/folders/2', folder({ title: 'Офис', exclude: [11, 12] }))).json();
  expect(edited.folders[0]).toMatchObject({ title: 'Офис', include: [10, 11], exclude: [12] });

  await call(a, 'PUT', '/settings/folders/3', folder({ title: 'Семья', include: [20], groups: false }));
  const del = await (await call(a, 'DELETE', '/settings/folders/2')).json();
  expect(del.folders.map((f: { id: number }) => f.id)).toEqual([3]);
  expect((await (await call(a, 'DELETE', '/settings/folders/2')).json()).seq).toBe(del.seq);   // повтор удаления — не ошибка и не запись

  const items = (await getUpdates(a.userId, 0)).items;
  expect(items.map((i) => i.update.type)).toEqual(['settingsChanged', 'settingsChanged', 'settingsChanged', 'settingsChanged']);
  const last = items[items.length - 1].update as { settings: { folders: { id: number }[] } };
  expect(last.settings.folders.map((f) => f.id)).toEqual([3]);
});

test('validation: title, empty rules, emoji, chat limit, folder limit, bad id', async () => {
  const a = await login('Анна');
  const code = async (r: Response) => [r.status, (await r.json()).code];
  expect(await code(await call(a, 'PUT', '/settings/folders/2', folder({ title: '   ' })))).toEqual([400, 'folder_title']);
  expect(await code(await call(a, 'PUT', '/settings/folders/2', folder({ title: 'Очень длинное имя' })))).toEqual([400, 'folder_title']);
  expect(await code(await call(a, 'PUT', '/settings/folders/2', folder({ include: [], groups: false })))).toEqual([400, 'folder_empty']);
  expect(await code(await call(a, 'PUT', '/settings/folders/2', folder({ emoji: 'ab' })))).toEqual([400, 'folder_emoji']);
  expect(await code(await call(a, 'PUT', '/settings/folders/2', folder({ include: Array.from({ length: 201 }, (_, i) => i + 1) })))).toEqual([400, 'folder_too_many_chats']);
  expect(await code(await call(a, 'PUT', '/settings/folders/1', folder()))).toEqual([400, 'bad_frame']);
  for (let id = 2; id < 12; id++) expect((await call(a, 'PUT', `/settings/folders/${id}`, folder({ title: 'П' + id }))).status).toBe(200);
  expect(await code(await call(a, 'PUT', '/settings/folders/12', folder()))).toEqual([400, 'folders_limit']);
  // правка существующей при полном списке — можно
  expect((await call(a, 'PUT', '/settings/folders/5', folder({ title: 'Пять' }))).status).toBe(200);
  expect((await call({ userId: 0, token: 'x' }, 'PUT', '/settings/folders/2', folder())).status).toBe(401);
});

test('order: known ids in the given order, forgotten ones keep their place at the end; folders are per user', async () => {
  const a = await login('Анна'), b = await login('Борис');
  for (const id of [2, 3, 4]) await call(a, 'PUT', `/settings/folders/${id}`, folder({ title: 'П' + id }));
  const r = await (await call(a, 'PUT', '/settings/folders/order', { ids: [4, 999, 2] })).json();
  expect(r.folders.map((f: { id: number }) => f.id)).toEqual([4, 2, 3]);
  expect((await call(a, 'PUT', '/settings/folders/order', { ids: 'x' })).status).toBe(400);
  expect((await (await call(b, 'GET', '/settings')).json()).folders).toEqual([]);
});
