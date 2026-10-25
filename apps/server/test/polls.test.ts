import { beforeEach, expect, test } from 'bun:test';
import { normalizePoll, parseClientFrame, pollPercents, type Poll } from '@relay/protocol';
import { sql } from '../src/db';
import { getHistory } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { getChatUpdates } from '../src/domain/chatJournal';
import { sendMessage } from '../src/domain/messages';
import { closeExpired, closePoll, pollVoters, votePoll } from '../src/domain/polls';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const poll = (o: Record<string, unknown> = {}) => ({ question: 'Куда едем?', options: ['Море', 'Горы', 'Дача'], multiple: false, quiz: false, anonymous: true, ...o });
const pollOf = async (userId: number, chat: number, id: number) =>
  (await getHistory(userId, chat, null, 50)).messages.find((m) => m.id === id)!.poll as Poll;

test('normalizePoll: limits like Telegram, quiz needs one correct answer, no duplicate options', () => {
  expect(normalizePoll(poll({ question: '  Куда\nедем? ' }))).toEqual({ question: 'Куда едем?', options: ['Море', 'Горы', 'Дача'], multiple: false, quiz: false, anonymous: true });
  expect(normalizePoll(poll({ options: ['Одно'] }))).toBeNull();
  expect(normalizePoll(poll({ options: Array.from({ length: 11 }, (_, i) => 'в' + i) }))).toBeNull();
  expect(normalizePoll(poll({ options: ['Море', 'море'] }))).toBeNull();
  expect(normalizePoll(poll({ quiz: true }))).toBeNull();
  expect(normalizePoll(poll({ quiz: true, correct: 1, multiple: true, solution: 'потому что' }))).toMatchObject({ quiz: true, multiple: false, correct: 1, solution: 'потому что' });
  expect(normalizePoll(poll({ closesIn: 3 }))).toBeNull();
  expect(parseClientFrame(JSON.stringify({ op: 'pollVote', reqId: 'r', chatId: 1, id: 2, options: ['x'] }))).toBeNull();
  expect(pollPercents([1, 1, 1])).toEqual([34, 33, 33]);
  expect(pollPercents([0, 0])).toEqual([0, 0]);
});

test('vote, see totals and own choice, retract; single choice; definition is sealed', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b, c]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', poll: normalizePoll(poll())! });
  expect(message).toMatchObject({ kind: 'poll', body: 'Куда едем?', poll: { options: [{ id: 1, text: 'Море' }, { id: 2, text: 'Горы' }, { id: 3, text: 'Дача' }], voters: 0, counts: [0, 0, 0], closed: false } });
  const [row] = await sql`select poll, content from messages where chat_id = ${chat} and id = ${message.id}`;
  if (row.content) expect(row.poll).toBeNull();   // вопрос и варианты — в шифре, не открытым столбцом

  await expect(votePoll(b, chat, message.id, [1, 2])).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(votePoll(b, chat, message.id, [9])).rejects.toMatchObject({ code: 'bad_frame' });
  expect(await votePoll(b, chat, message.id, [2])).toEqual({ changed: true });
  await votePoll(c, chat, message.id, [2]);
  await expect(votePoll(b, chat, message.id, [1])).rejects.toMatchObject({ code: 'forbidden' });   // сначала отозвать
  expect(await pollOf(b, chat, message.id)).toMatchObject({ voters: 2, counts: [0, 2, 0], my: [2] });
  expect((await pollOf(a, chat, message.id)).my).toBeUndefined();

  // общие итоги — всем, свои голоса — только в своём журнале
  const ca = (await getChatUpdates(a, chat, 0)).items.map((i) => i.update);
  expect(ca.filter((u) => u.type === 'pollUpdated').at(-1)).toMatchObject({ voters: 2, counts: [0, 2, 0], closed: false });
  expect((await getUpdates(a, 0)).items.some((i) => i.update.type === 'pollVoted')).toBe(false);
  // новое сообщение-опрос в журнале группы — с итогами для читающего
  expect((await getChatUpdates(b, chat, 0)).items.map((i) => i.update).find((u) => u.type === 'newMessage' && u.message.kind === 'poll')).toMatchObject({ message: { poll: { my: [2], voters: 2 } } });
  const ub = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(ub.find((u) => u.type === 'pollVoted')).toMatchObject({ chatId: chat, id: message.id, my: [2] });

  expect(await votePoll(b, chat, message.id, [])).toEqual({ changed: true });
  expect(await votePoll(b, chat, message.id, [])).toEqual({ changed: false });
  expect(await pollOf(b, chat, message.id)).toMatchObject({ voters: 1, counts: [0, 1, 0] });
});

test('quiz: answer hidden until you vote, final; closing reveals it to everyone; only the author closes', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b, c]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', poll: normalizePoll(poll({ quiz: true, correct: 1, solution: 'Горы ближе' }))! });
  expect(message.poll!.correct).toBeUndefined();
  expect(JSON.stringify(message)).not.toContain('Горы ближе');   // в событии нового сообщения ответа нет
  expect((await pollOf(b, chat, message.id)).correct).toBeUndefined();
  await votePoll(b, chat, message.id, [1]);
  expect(await pollOf(b, chat, message.id)).toMatchObject({ my: [1], correct: 2, solution: 'Горы ближе' });
  expect((await getUpdates(b, 0)).items.map((i) => i.update).find((u) => u.type === 'pollVoted')).toMatchObject({ my: [1], correct: 2, solution: 'Горы ближе' });
  await expect(votePoll(b, chat, message.id, [])).rejects.toMatchObject({ code: 'forbidden' });   // ответ окончателен
  expect((await pollOf(c, chat, message.id)).correct).toBeUndefined();

  await expect(closePoll(b, chat, message.id)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await closePoll(a, chat, message.id)).toEqual({ changed: true });
  expect(await pollOf(c, chat, message.id)).toMatchObject({ closed: true, correct: 2, solution: 'Горы ближе' });
  await expect(votePoll(c, chat, message.id, [2])).rejects.toMatchObject({ code: 'forbidden' });
  expect((await getChatUpdates(c, chat, 0)).items.map((i) => i.update).filter((u) => u.type === 'pollUpdated').at(-1)).toMatchObject({ closed: true, correct: 2 });
});

test('auto-close after the deadline; public poll lists voters, anonymous does not', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', poll: normalizePoll(poll({ anonymous: false, closesIn: 5 }))! });
  const [job] = await sql`select run_at from jobs where kind = 'poll.close'`;
  expect(job).toBeTruthy();
  await votePoll(b, chat, message.id, [3]);
  expect(await pollVoters(a, chat, message.id)).toEqual([{ option: 1, users: [] }, { option: 2, users: [] }, { option: 3, users: [{ id: b, name: 'Борис' }] }]);
  await closeExpired(chat, message.id);   // срок не вышел — ничего
  expect((await pollOf(a, chat, message.id)).closed).toBe(false);
  // срок вышел: подвинем его в прошлое (в шифре — через updateContent тем же путём, что и сервер)
  const { updateContent } = await import('../src/domain/messageContent');
  await sql.begin((tx) => updateContent(tx, chat, message.id, (c) => ({ poll: { ...(c.poll as object), closesAt: new Date(Date.now() - 1000).toISOString() } })));
  await closeExpired(chat, message.id);
  expect((await pollOf(a, chat, message.id)).closed).toBe(true);

  const { message: anon } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', poll: normalizePoll(poll())! });
  await expect(pollVoters(a, chat, anon.id)).rejects.toMatchObject({ code: 'forbidden' });
});

test('forwarded poll is a fresh poll with the same question; poll shows in the chat list preview', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]), other = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', poll: normalizePoll(poll())! });
  await votePoll(b, chat, message.id, [1]);
  const { message: fwd } = await sendMessage(b, { chatId: other, clientId: crypto.randomUUID(), body: '', forward: { chatId: chat, id: message.id } });
  expect(fwd).toMatchObject({ kind: 'poll', poll: { question: 'Куда едем?', voters: 0 } });
  expect((await pollOf(b, other, fwd.id)).my).toBeUndefined();
});
