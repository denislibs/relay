import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Engine } from '../src/engine';
import { resetDb, startTestServer } from './helpers';

// позиции прокрутки чатов: meta «pos:<ключ>» в IndexedDB — переживают перезапуск движка (перезагрузку страницы);
// null стирает запись (чат был внизу)

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('positions survive an engine restart; null removes the entry', async () => {
  const a = await srv.login('a');
  const cfg = srv.config(a);
  const e1 = await open(cfg);
  expect(await e1.call({ type: 'positions' })).toEqual({});
  await e1.call({ type: 'setPosition', key: '7', pos: { key: 'k9', sort: 9, offset: 120 } });
  await e1.call({ type: 'setPosition', key: '7:3', pos: { key: 'k2', sort: 2, offset: 0 } });
  await e1.close(); engines.splice(engines.indexOf(e1), 1);
  const e2 = await open(cfg);
  expect(await e2.call({ type: 'positions' })).toEqual({ '7': { key: 'k9', sort: 9, offset: 120 }, '7:3': { key: 'k2', sort: 2, offset: 0 } });
  await e2.call({ type: 'setPosition', key: '7', pos: null });
  await e2.call({ type: 'setPosition', key: 'none', pos: null });   // стирать нечего — не ошибка
  expect(await e2.call({ type: 'positions' })).toEqual({ '7:3': { key: 'k2', sort: 2, offset: 0 } });
});
