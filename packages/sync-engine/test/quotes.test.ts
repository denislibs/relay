import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { deleteMessage, editMessage } from '../../../apps/server/src/domain/messageOps';
import { sendMessage } from '../../../apps/server/src/domain/messages';
import { Engine } from '../src/engine';
import { resetDb, startTestServer, watchInto } from './helpers';

const srv = await startTestServer();
afterAll(() => srv.stop());
const engines: Engine[] = [];
beforeEach(resetDb);
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });
const open = async (cfg: Parameters<typeof Engine.open>[0]) => { const e = await Engine.open(cfg); engines.push(e); return e; };

async function setup() {
  const a = await srv.login('Анна'), b = await srv.login('Борис');
  const chatId = await srv.chat(a.token, [a.userId, b.userId]);
  const src = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'начало важный кусок конец', entities: [{ type: 'bold', offset: 7, length: 6 }] })).message;
  return { a, b, chatId, src };
}
const quote = { text: 'важный кусок', offset: 7, entities: [{ type: 'bold' as const, offset: 0, length: 6 }] };

test('a quote shows at once, reaches the second device and the other person', async () => {
  const { a, b, chatId, src } = await setup();
  const eb1 = await open(srv.config(b)), eb2 = await open(srv.config(b)), ea = await open(srv.config(a));
  for (const e of [eb1, eb2, ea]) e.connect();
  const f1 = watchInto(eb1, { kind: 'messages', chatId, limit: 20 }), f2 = watchInto(eb2, { kind: 'messages', chatId, limit: 20 }), fa = watchInto(ea, { kind: 'messages', chatId, limit: 20 });
  await Promise.all([eb1.whenIdle(), eb2.whenIdle(), ea.whenIdle()]);
  await eb1.call({ type: 'sendMessage', chatId, body: 'ответ', replyToId: src.id, replyQuote: quote });
  const mine = await f1.until((l) => l.some((m) => m.body === 'ответ'));
  expect(mine.find((m) => m.body === 'ответ')!.replyQuote).toMatchObject({ text: quote.text });
  for (const f of [f1, f2, fa]) {
    const l = await f.until((x) => x.some((m) => m.body === 'ответ' && m.id != null));
    expect(l.find((m) => m.body === 'ответ')!.replyQuote).toEqual(quote);
  }
});

test('offline: the quote waits in the queue with the reply and goes on reconnect, surviving a restart', async () => {
  const { b, chatId, src } = await setup();
  const cfg = srv.config(b);
  const e1 = await open(cfg);
  e1.connect();
  const f0 = watchInto(e1, { kind: 'messages', chatId, limit: 20 });
  await f0.until((l) => l.some((m) => m.id === src.id));
  await e1.whenIdle();
  e1.disconnect();
  await e1.call({ type: 'sendMessage', chatId, body: 'без сети', replyToId: src.id, replyQuote: quote });
  const pending = await f0.until((l) => l.some((m) => m.body === 'без сети'));
  expect(pending.find((m) => m.body === 'без сети')).toMatchObject({ status: 'pending', replyQuote: { text: quote.text } });
  await e1.close();
  engines.splice(engines.indexOf(e1), 1);
  const e2 = await open(cfg);
  e2.connect();
  const f = watchInto(e2, { kind: 'messages', chatId, limit: 20 });
  const l = await f.until((x) => x.some((m) => m.body === 'без сети' && m.status === 'sent'));
  expect(l.find((m) => m.body === 'без сети')!.replyQuote).toEqual(quote);
});

test('offline, the fragment edited away meanwhile: the reply goes without it instead of hanging failed', async () => {
  const { a, b, chatId, src } = await setup();
  const eb = await open(srv.config(b));
  eb.connect();
  const f = watchInto(eb, { kind: 'messages', chatId, limit: 20 });
  await f.until((l) => l.some((m) => m.id === src.id));
  await eb.whenIdle();
  eb.disconnect();
  await eb.call({ type: 'sendMessage', chatId, body: 'запоздал', replyToId: src.id, replyQuote: quote });
  await editMessage(a.userId, chatId, src.id, 'всё другое');
  eb.connect();
  const l = await f.until((x) => x.some((m) => m.body === 'запоздал' && m.status === 'sent'));
  const m = l.find((x) => x.body === 'запоздал')!;
  expect(m.replyToId).toBe(src.id);
  expect(m.replyQuote).toBeUndefined();
});

test('the source is deleted: the device forgets the fragment too', async () => {
  const { a, b, chatId, src } = await setup();
  const eb = await open(srv.config(b));
  eb.connect();
  const f = watchInto(eb, { kind: 'messages', chatId, limit: 20 });
  await f.until((l) => l.some((m) => m.id === src.id));
  await eb.call({ type: 'sendMessage', chatId, body: 'ответ', replyToId: src.id, replyQuote: quote });
  await f.until((x) => x.some((m) => m.body === 'ответ' && m.status === 'sent'));
  await deleteMessage(a.userId, chatId, src.id);
  const l = await f.until((x) => x.some((m) => m.body === 'ответ' && !m.replyQuote));
  expect((l.find((m) => m.body === 'ответ')!.reply as { deleted?: boolean }).deleted).toBe(true);
});

test('scheduled reply with a quote: shown in the list of scheduled', async () => {
  const { b, chatId, src } = await setup();
  const eb = await open(srv.config(b));
  eb.connect();
  await eb.whenIdle();
  await eb.call({ type: 'sendMessage', chatId, body: 'потом', replyToId: src.id, replyQuote: quote, scheduleAt: Date.now() + 60_000 });
  const list = watchInto(eb, { kind: 'scheduled', chatId } as never);
  const l = await list.until((x) => x.some((m) => m.body === 'потом'));
  expect(l.find((m) => m.body === 'потом')!.replyQuote).toMatchObject({ text: quote.text });
});

test('blockquote entities (with collapsed) reach the other device and a change of collapsed alone updates the row', async () => {
  const { a, b, chatId } = await setup();
  const eb = await open(srv.config(b));
  eb.connect();
  const f = watchInto(eb, { kind: 'messages', chatId, limit: 20 });
  await eb.whenIdle();
  const m = (await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'цитата', entities: [{ type: 'blockquote', offset: 0, length: 6 }] })).message;
  await f.until((x) => x.some((y) => y.id === m.id && (y.entities as unknown[]).length === 1));
  await editMessage(a.userId, chatId, m.id, 'цитата', [{ type: 'blockquote', offset: 0, length: 6, collapsed: true }]);
  await f.until((x) => x.some((y) => y.id === m.id && (y.entities as { collapsed?: boolean }[])[0].collapsed === true));
});
