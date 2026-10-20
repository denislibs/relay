import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };
const chatOf = (l: Record<string, any>[], id: number) => l.find((i) => i.id === id);
const ids = (l: Record<string, any>[]) => l.map((i) => i.id);
const say = (userId: number, chatId: number, body: string) => sendMessage(userId, { chatId, clientId: crypto.randomUUID(), body });

test('pin, archive and unread mark: at once on this device, through the journal on another; pinned on top; counters', async () => {
  const a = await srv.login('a'), b = await srv.login('b'), c = await srv.login('c');
  const ab = await srv.chat(a.token, [a.userId, b.userId]);
  const ac = await srv.chat(a.token, [a.userId, c.userId]);
  await say(b.userId, ab, 'старое');   // ab старше ac по последнему сообщению
  await say(c.userId, ac, 'новое');
  const e1 = await open(srv.config(a)), e2 = await open(srv.config(a));
  e1.connect(); e2.connect();
  await Promise.all([e1.whenIdle(), e2.whenIdle()]);
  const l1 = watchInto(e1, { kind: 'chatList', limit: 50 }), l2 = watchInto(e2, { kind: 'chatList', limit: 50 });
  const n2 = watchInto(e2, { kind: 'counters' });
  await l2.until((l) => ids(l).indexOf(ac) < ids(l).indexOf(ab));

  await e1.call({ type: 'setChatFlags', chatId: ab, pinned: true });
  await l1.until((l) => ids(l)[0] === ab && chatOf(l, ab)?.pinnedAt != null);    // сразу, до ответа сервера
  await l2.until((l) => ids(l)[0] === ab && chatOf(l, ab)?.pinnedAt != null);    // по журналу
  await say(c.userId, ac, 'ещё новее');
  await l2.until((l) => chatOf(l, ac)?.last?.body === 'ещё новее');
  expect(ids(l2.list())[0]).toBe(ab);                                              // новое сообщение закреплённый не обгоняет

  await e1.call({ type: 'setChatFlags', chatId: ac, archived: true });
  await l2.until((l) => chatOf(l, ac)?.archived === true);
  await n2.until((l) => l[0]?.archivedUnread === 1 && l[0]?.unreadChats === 1);   // архив — отдельным счётом

  await e1.call({ type: 'setChatFlags', chatId: ab, archived: true });            // в архив — закрепление снимается
  await l2.until((l) => chatOf(l, ab)?.archived === true && chatOf(l, ab)?.pinnedAt === null);

  await e1.call({ type: 'setChatFlags', chatId: ac, archived: false, unreadMark: true });
  await l2.until((l) => chatOf(l, ac)?.archived === false && chatOf(l, ac)?.unreadMark === true);
  await e1.whenIdle();
  await l1.until((l) => chatOf(l, ac)?.unreadMark === true);                      // после подтверждения — без отката
});
