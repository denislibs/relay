import { beforeEach, expect, test } from 'bun:test';
import { normalizeTodo, parseClientFrame } from '@relay/protocol';
import { getHistory } from '../src/domain/chats';
import { getUpdates } from '../src/domain/journal';
import { sendMessage } from '../src/domain/messages';
import { appendTodo, editTodo, toggleTodo } from '../src/domain/todo';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const list = (title: string, items: string[], o: Partial<{ othersCanAppend: boolean; othersCanComplete: boolean }> = {}) =>
  ({ title, items: items.map((t) => ({ title: t })), othersCanAppend: !!o.othersCanAppend, othersCanComplete: !!o.othersCanComplete });

test('normalizeTodo: trims, drops empty tasks, enforces Telegram limits', () => {
  expect(normalizeTodo({ title: '  Покупки\n', items: [{ title: ' хлеб ' }, { title: '' }, 'молоко'], othersCanComplete: true }))
    .toEqual({ title: 'Покупки', items: [{ title: 'хлеб' }, { title: 'молоко' }], othersCanAppend: false, othersCanComplete: true });
  expect(normalizeTodo({ title: '', items: [{ title: 'x' }] })).toBeNull();
  expect(normalizeTodo({ title: 'x', items: [] })).toBeNull();
  expect(normalizeTodo({ title: 'x'.repeat(33), items: [{ title: 'x' }] })).toBeNull();
  expect(normalizeTodo({ title: 'x', items: [{ title: 'y'.repeat(65) }] })).toBeNull();
  expect(normalizeTodo({ title: 'x', items: Array.from({ length: 31 }, () => ({ title: 'a' })) })).toBeNull();
  expect(parseClientFrame(JSON.stringify({ op: 'todoToggle', reqId: 'r', chatId: 1, id: 2, completed: [1], incompleted: ['x'] }))).toBeNull();
});

test('a checklist: numbered 1..N, the author ticks, others only when allowed; every change is a service line to all', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', todo: list('Поездка', ['билеты', 'отель']) });
  expect(message).toMatchObject({ kind: 'todo', body: 'Поездка', todo: { title: 'Поездка', items: [{ id: 1, title: 'билеты' }, { id: 2, title: 'отель' }], completions: [] } });

  await expect(toggleTodo(b, chat, message.id, [1], [])).rejects.toMatchObject({ code: 'forbidden' });
  expect(await toggleTodo(a, chat, message.id, [1], [])).toEqual({ changed: true });
  expect(await toggleTodo(a, chat, message.id, [1], [])).toEqual({ changed: false });   // повтор — без записи
  const ups = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(ups.find((u) => u.type === 'todoUpdated')).toMatchObject({ todo: { completions: [{ id: 1, by: a }] } });
  const line = ups.filter((u) => u.type === 'newMessage').map((u) => (u as { message: { service?: unknown; replyToId: number | null } }).message).at(-1)!;
  expect(line).toMatchObject({ service: { type: 'todo_done', data: { completed: [1] } }, replyToId: message.id });
  await expect(appendTodo(b, chat, message.id, ['виза'])).rejects.toMatchObject({ code: 'forbidden' });
});

test('others can tick and append when allowed; appended ids continue; edit keeps ids and their ticks', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', todo: list('Дом', ['пол', 'окна'], { othersCanAppend: true, othersCanComplete: true }) });
  await toggleTodo(b, chat, message.id, [2], []);
  expect(await appendTodo(b, chat, message.id, ['  крыша ', 'двор'])).toEqual({ ids: [3, 4] });
  await expect(editTodo(b, chat, message.id, { title: 'Чужое', items: [{ title: 'x' }], othersCanAppend: false, othersCanComplete: false })).rejects.toMatchObject({ code: 'forbidden' });
  // автор убрал «пол», переименовал «окна» (id 2 с отметкой остаётся), добавил новую задачу
  await editTodo(a, chat, message.id, { title: 'Дом и сад', items: [{ id: 2, title: 'окна!' }, { id: 4, title: 'двор' }, { title: 'сад' }], othersCanAppend: false, othersCanComplete: true });
  const h = (await getHistory(a, chat, null, 20)).messages.find((m) => m.id === message.id)!;
  expect(h.todo).toMatchObject({ title: 'Дом и сад', items: [{ id: 2, title: 'окна!' }, { id: 4, title: 'двор' }, { id: 5, title: 'сад' }], othersCanAppend: false, completions: [{ id: 2, by: b }] });
  expect(h.body).toBe('Дом и сад');
  expect(h.editedAt).toBeTruthy();
});

test('a forwarded checklist is a read-only copy', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]), other = await makeChat([b, c]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '', todo: list('Список', ['раз'], { othersCanComplete: true }) });
  const fwd = await sendMessage(b, { chatId: other, clientId: crypto.randomUUID(), body: '', forward: { chatId: chat, id: message.id } });
  expect(fwd.message).toMatchObject({ kind: 'todo', todo: { title: 'Список' } });
  await expect(toggleTodo(c, other, fwd.message.id, [1], [])).rejects.toMatchObject({ code: 'forbidden' });
});
