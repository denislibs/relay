import { beforeEach, expect, mock, test } from 'bun:test';

// пересылка уходит в движок через data.ts — подменяем его, считаем вызовы
const calls: Record<string, unknown>[] = [];
mock.module('./data', () => ({
  forwardMessages: async (a: Record<string, unknown>) => { calls.push(a); },
  openInner: () => {},
  sentSound: () => {},
}));
mock.module('./settingsData', () => ({ showToast: () => {} }));

const { forwardTo, startForwardMany } = await import('./forward');
const { getGlobal, setGlobal } = await import('./global');

beforeEach(() => { calls.length = 0; setGlobal({ fwdPick: null, fwdDraft: {} }); });

const msg = (id: number, senderId = 1) => ({ id, senderId, body: 'm' + id });

test('selection from several chats: one pick, parts by source chat, preview over all', () => {
  startForwardMany([{ chatId: 5, items: [msg(9), msg(3)] }, { chatId: 7, items: [msg(4, 2)] }], (id) => 'u' + id);
  const p = getGlobal().fwdPick!;
  expect(p.fromChatId).toBe(5);
  expect(p.ids).toEqual([3, 9]);
  expect(p.more).toEqual([{ fromChatId: 7, ids: [4] }]);
  expect(p.preview.count).toBe(3);
  expect(p.preview.senders.map((s) => s.name)).toEqual(['u1', 'u2']);
});

test('one source chat: no extra parts', () => {
  startForwardMany([{ chatId: 5, items: [msg(1)] }], () => '');
  expect(getGlobal().fwdPick!.more).toBeUndefined();
});

test('forward to several chats: one call per source chat, comment only with the first', async () => {
  startForwardMany([{ chatId: 5, items: [msg(1)] }, { chatId: 7, items: [msg(2)] }], () => '');
  await forwardTo([10, 11], 'hi');
  expect(calls).toEqual([
    { toChatIds: [10, 11], comment: { body: 'hi' }, fromChatId: 5, ids: [1] },
    { toChatIds: [10, 11], comment: null, fromChatId: 7, ids: [2] },
  ]);
});
