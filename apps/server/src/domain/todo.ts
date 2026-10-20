import { normalizeTodo, TODO_ITEMS_MAX, TODO_ITEM_MAX, type Message, type Todo, type TodoInput, type TodoServiceData, type Update } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { assertMember, toMessage } from './chats';
import { DomainError } from './errors';
import { fanOut } from './journal';
import { lockOpen, updateContent } from './messageContent';
import { blockedInDirect } from './privacy';

/**
 * Чек-листы, как в Telegram: автор создаёт список (задачи 1..N); отмечать могут автор и — если разрешено — другие,
 * добавлять задачи — автор и — если разрешено — другие (номера продолжаются: максимум + 1); править — только автор.
 * Каждая отметка и добавление — служебная строка в чате («X отметил(а) …»), ссылкой на список (reply_to_id).
 */

/** Новый список из ввода клиента: номера 1..N по порядку, отметок нет. */
export function newTodo(input: TodoInput): Todo {
  return { title: input.title, items: input.items.map((it, i) => ({ id: i + 1, title: it.title })), othersCanAppend: input.othersCanAppend, othersCanComplete: input.othersCanComplete, completions: [] };
}

async function lockTodo(tx: Tx, chatId: number, id: number) {
  const m = await lockOpen(tx, chatId, id);   // список — в шифре: открыть под блокировкой
  if (!m || m.deleted || m.kind !== 'todo' || !m.todo) throw new DomainError('not_found', 'checklist');
  return { author: Number(m.sender_id), todo: m.todo as Todo, forwarded: !!m.fwd_from };
}
const members = async (tx: Tx, chatId: number) => (await tx`select user_id from chat_members where chat_id = ${chatId}`).map((r) => Number(r.user_id));

/** Служебная строка о чек-листе: от того, кто отметил/добавил, ответом на сам список. */
async function serviceLine(tx: Tx, chatId: number, userId: number, listId: number, type: 'todo_done' | 'todo_append', data: TodoServiceData, to: number[]): Promise<Message> {
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, service_type, service_data, reply_to_id)
    values (${chatId}, ${userId}, ${crypto.randomUUID()}, 'text', '', ${type}, ${sql.json(data as never)}, ${listId}) returning *`;
  const message = toMessage(row);
  await fanOut(tx, to, { type: 'newMessage', message });
  return message;
}

async function publish(tx: Tx, chatId: number, id: number, todo: Todo, to: number[], editedAt?: string) {
  await fanOut(tx, to, { type: 'todoUpdated', chatId, id, todo, ...(editedAt ? { editedAt } : {}) } satisfies Update);
}

/** Отметить / снять отметки. Повтор того же — без записи. */
export async function toggleTodo(userId: number, chatId: number, id: number, completed: number[], incompleted: number[]): Promise<{ changed: boolean }> {
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const { author, todo, forwarded } = await lockTodo(tx, chatId, id);
    // пересланный список — только для чтения; чужой — если автор разрешил
    if (forwarded || (author !== userId && !todo.othersCanComplete)) throw new DomainError('forbidden', 'checklist');
    const ids = new Set(todo.items.map((x) => x.id));
    const done = new Set(todo.completions.map((c) => c.id));
    const add = [...new Set(completed)].filter((x) => ids.has(x) && !done.has(x));
    const remove = new Set([...new Set(incompleted)].filter((x) => ids.has(x) && done.has(x) && !add.includes(x)));
    if (!add.length && !remove.size) return { changed: false };
    const at = new Date().toISOString();
    const next: Todo = { ...todo, completions: todo.completions.filter((c) => !remove.has(c.id)).concat(add.map((x) => ({ id: x, by: userId, at }))) };
    await updateContent(tx, chatId, id, () => ({ todo: next }));
    const to = await members(tx, chatId);
    await publish(tx, chatId, id, next, to);
    await serviceLine(tx, chatId, userId, id, 'todo_done', { ...(add.length ? { completed: add } : {}), ...(remove.size ? { incompleted: [...remove] } : {}) }, to);
    return { changed: true };
  });
}

/** Добавить задачи в конец: автору — всегда, другим — если разрешено; не больше предела. */
export async function appendTodo(userId: number, chatId: number, id: number, titles: string[]): Promise<{ ids: number[] }> {
  const clean = titles.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) throw new DomainError('bad_frame', 'items');
  if (clean.some((t) => [...t].length > TODO_ITEM_MAX)) throw new DomainError('too_long');
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const { author, todo, forwarded } = await lockTodo(tx, chatId, id);
    if (forwarded || (author !== userId && !todo.othersCanAppend)) throw new DomainError('forbidden', 'checklist');
    if (todo.items.length + clean.length > TODO_ITEMS_MAX) throw new DomainError('too_long', 'items');
    let max = todo.items.reduce((m, x) => Math.max(m, x.id), 0);
    const added = clean.map((title) => ({ id: ++max, title }));
    const next: Todo = { ...todo, items: todo.items.concat(added) };
    await updateContent(tx, chatId, id, () => ({ todo: next }));
    const to = await members(tx, chatId);
    await publish(tx, chatId, id, next, to);
    await serviceLine(tx, chatId, userId, id, 'todo_append', { items: added.map((x) => x.id) }, to);
    return { ids: added.map((x) => x.id) };
  });
}

/** Правка списка автором: у задач с номером номер сохраняется (и их отметки), новые — максимум + 1. Без ограничения по времени. */
export async function editTodo(userId: number, chatId: number, id: number, raw: TodoInput): Promise<{ editedAt: string }> {
  const input = normalizeTodo(raw);
  if (!input) throw new DomainError('bad_frame', 'checklist');
  return sql.begin(async (tx) => {
    await assertMember(tx, chatId, userId);
    if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    const { author, todo, forwarded } = await lockTodo(tx, chatId, id);
    if (author !== userId || forwarded) throw new DomainError('forbidden', 'checklist');
    const old = new Set(todo.items.map((x) => x.id));
    let max = todo.items.reduce((m, x) => Math.max(m, x.id), 0);
    const items = input.items.map((it) => ({ id: it.id != null && old.has(it.id) ? it.id : ++max, title: it.title }));
    const keep = new Set(items.map((x) => x.id));
    const next: Todo = { title: input.title, items, othersCanAppend: input.othersCanAppend, othersCanComplete: input.othersCanComplete, completions: todo.completions.filter((c) => keep.has(c.id)) };
    const row = (await updateContent(tx, chatId, id, () => ({ todo: next, body: next.title }), () => ({ edited_at: sql`now()` })))!;
    const editedAt = new Date(row.edited_at as string).toISOString();
    await publish(tx, chatId, id, next, await members(tx, chatId), editedAt);
    return { editedAt };
  });
}
