import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { MessageButton } from '@relay/protocol';
import { sql } from '../../../apps/server/src/db';
import { createSession, sessionFromToken } from '../../../apps/server/src/auth';
import { announceLogin } from '../../../apps/server/src/domain/sessions';
import { LOGIN_CONFIRMED, serviceChatId } from '../../../apps/server/src/domain/service';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

// тесты движка идут с SERVICE_CHAT=off: приветствия нет, но «Новый вход» сам создаёт служебный чат
const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

test('buttons arrive with the message, pressButton answers with a toast and the markup edit removes them (also after reopen)', async () => {
  const a = await srv.login('Анна');
  const cfg = srv.config(a);
  const e = await open(cfg);
  e.connect();
  await e.whenIdle();

  const freshToken = await createSession(a.userId, undefined, { confirmed: false });
  const fresh = (await sessionFromToken(freshToken))!.sessionId;
  await announceLogin(a.userId, freshToken);
  const chatId = await serviceChatId(sql, a.userId);
  const feed = watchInto(e, { kind: 'messages', chatId, limit: 50 });
  const [m] = await feed.until((l) => l.some((x) => Array.isArray(x.buttons)));
  const rows = m.buttons as MessageButton[][];
  expect(rows.flat().map((b) => b.text)).toEqual(['Это я', 'Завершить этот сеанс', 'Завершить все остальные сеансы']);

  expect(await e.call({ type: 'pressButton', chatId, id: m.id as number, data: `login:ok:${fresh}` })).toEqual({ toast: 'Вход подтверждён' });
  const [after] = await feed.until((l) => l[0]?.buttons === null);
  expect((after.body as string).endsWith(LOGIN_CONFIRMED)).toBe(true);
  expect(after.editedAt).toBeNull();

  // нажатие на кнопку, которой уже нет, — ошибка сервера
  await expect(e.call({ type: 'pressButton', chatId, id: m.id as number, data: `login:ok:${fresh}` })).rejects.toBeDefined();

  // итог сохранён на устройстве: тот же кэш без сети — без кнопок и с итогом
  await e.close();
  engines.length = 0;
  const offline = await open(cfg);
  const cached = watchInto(offline, { kind: 'messages', chatId, limit: 50 });
  const [kept] = await cached.until((l) => l.length === 1);
  expect(kept.buttons ?? null).toBeNull();
  expect((kept.body as string).endsWith(LOGIN_CONFIRMED)).toBe(true);
});

test('pressButton offline is refused at once', async () => {
  const a = await srv.login('Анна');
  const e = await open(srv.config(a));
  await expect(e.call({ type: 'pressButton', chatId: 1, id: 1, data: 'login:ok:1' })).rejects.toThrow('offline');
});
