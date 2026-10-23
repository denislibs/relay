import type { ServerWebSocket } from 'bun';
import type { Bus } from './bus';
import { sql } from './db';

/**
 * Подписки сокетов на журналы чатов. Группа или канал — топик `chat:<id>` (Bun pub/sub внутри процесса: один
 * publish на всех подписчиков) плюс подписка процесса в Valkey на тот же топик (кадры мимо журнала: «печатает…»).
 * Сокет подписан на все свои группы с открытия; вступление/исключение подписывают и отписывают его через
 * NOTIFY личного журнала (s/x в notifyPayloads), а hello/chatsSince сверяют подписки с chat_members — страховка.
 * Реестр сокетов по пользователю — в этом процессе (у каждого сокета своя шина: тесты поднимают несколько серверов).
 */
export type ChatSocket = ServerWebSocket<{ userId: number; chats?: Set<number>; opened?: Promise<void> }>;

const byUser = new Map<number, Set<ChatSocket>>();
const busOf = new WeakMap<ChatSocket, Bus>();

export function registerSocket(ws: ChatSocket, bus: Bus): void {
  ws.data.chats ??= new Set();
  busOf.set(ws, bus);
  let set = byUser.get(ws.data.userId);
  if (!set) byUser.set(ws.data.userId, (set = new Set()));
  set.add(ws);
}

export function unregisterSocket(ws: ChatSocket): void {
  const set = byUser.get(ws.data.userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) byUser.delete(ws.data.userId);
}

export const socketsOf = (userId: number): ChatSocket[] => [...(byUser.get(userId) ?? [])];

export async function groupChatIds(userId: number): Promise<number[]> {
  const rows = await sql`select cm.chat_id from chat_members cm join chats c on c.id = cm.chat_id where cm.user_id = ${userId} and c.kind <> 'direct'`;
  return rows.map((r) => Number(r.chat_id));
}

export async function subscribeChat(ws: ChatSocket, chatId: number): Promise<void> {
  const chats = (ws.data.chats ??= new Set());
  if (chats.has(chatId)) return;
  chats.add(chatId);
  ws.subscribe(`chat:${chatId}`);
  await busOf.get(ws)?.listen(`chat:${chatId}`).catch((e) => console.error('bus:', e));
}

export async function unsubscribeChat(ws: ChatSocket, chatId: number): Promise<void> {
  const chats = ws.data.chats;
  if (!chats?.has(chatId)) return;
  chats.delete(chatId);
  ws.unsubscribe(`chat:${chatId}`);
  await busOf.get(ws)?.unlisten(`chat:${chatId}`).catch((e) => console.error('bus:', e));
}

/** Привести подписки сокета к текущему составу групп пользователя (открытие сокета, hello, chatsSince). */
export async function syncSubscriptions(ws: ChatSocket): Promise<void> {
  const mine = new Set(await groupChatIds(ws.data.userId));
  const chats = (ws.data.chats ??= new Set());
  for (const id of mine) if (!chats.has(id)) await subscribeChat(ws, id);
  for (const id of [...chats]) if (!mine.has(id)) await unsubscribeChat(ws, id);
}

/** Сокет закрывается: отписать процесс в Valkey от топиков его чатов (Bun снимает свои подписки сам). */
export async function releaseChats(ws: ChatSocket): Promise<void> {
  for (const id of [...(ws.data.chats ?? [])]) await unsubscribeChat(ws, id);
}

/** NOTIFY личного журнала: вступил (s) / исключён (x) — сокеты этого пользователя в этом процессе. */
export function subscribeUserSockets(userId: number, chatId: number): void {
  for (const ws of socketsOf(userId)) void subscribeChat(ws, chatId);
}
export function unsubscribeUserSockets(userId: number, chatId: number): void {
  for (const ws of socketsOf(userId)) void unsubscribeChat(ws, chatId);
}
