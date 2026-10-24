import type { ServerWebSocket } from 'bun';
import type { Bus } from './bus';
import { sql } from './db';
import { canRead } from './domain/chats';
import { threadAccess } from './domain/threads';

/**
 * Подписки сокетов на журналы чатов. Группа или канал — топик `chat:<id>` (Bun pub/sub внутри процесса: один
 * publish на всех подписчиков) плюс подписка процесса в Valkey на тот же топик (кадры мимо журнала: «печатает…»).
 * Сокет подписан на все свои группы с открытия; вступление/исключение подписывают и отписывают его через
 * NOTIFY личного журнала (s/x в notifyPayloads), а hello/chatsSince сверяют подписки с chat_members — страховка.
 * Реестр сокетов по пользователю — в этом процессе (у каждого сокета своя шина: тесты поднимают несколько серверов).
 */
// threads — треды гостя (threads.ts threadAccess): «группа:копия» → канал, через который у гостя доступ
export type ChatSocket = ServerWebSocket<{ userId: number; chats?: Set<number>; threads?: Map<string, number>; opened?: Promise<void>; watching?: Set<number> }>;

/** Сколько чужих топиков сокет держит одновременно — превью публичных каналов и треды гостя вместе (как shortpoll в
 *  Telegram Web A — до 10). */
export const WATCH_MAX = 10;
const watchSlots = (ws: ChatSocket) => (ws.data.watching?.size ?? 0) + (ws.data.threads?.size ?? 0);

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
  const rows = await sql`select cm.chat_id from chat_members cm join chats c on c.id = cm.chat_id where cm.user_id = ${userId} and c.kind <> 'direct' and c.deleted_at is null`;
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

/**
 * Превью публичного канала (watchChat): топик канала без членства, пока превью открыто. Права проверяет вызывающий
 * (canRead). Сверка подписок такие топики не снимает; unwatch снимает, только если человек так и не вступил.
 */
export async function watchChat(ws: ChatSocket, chatId: number): Promise<boolean> {
  const watching = (ws.data.watching ??= new Set());
  if (!watching.has(chatId) && watchSlots(ws) >= WATCH_MAX) return false;
  watching.add(chatId);
  await subscribeChat(ws, chatId);
  return true;
}

export async function unwatchChat(ws: ChatSocket, chatId: number): Promise<void> {
  if (!ws.data.watching?.delete(chatId)) return;
  const [m] = await sql`select 1 from chat_members where chat_id = ${chatId} and user_id = ${ws.data.userId}`;
  if (!m) await unsubscribeChat(ws, chatId);
}

/**
 * Привести подписки сокета к текущему составу групп пользователя (открытие сокета, hello, chatsSince). Превью
 * остаются, пока их можно читать (canRead): канал удалили, сделали приватным или забанили — превью снимается.
 */
export async function syncSubscriptions(ws: ChatSocket): Promise<void> {
  await recheckSocketThreads(ws);   // треды гостя — пока доступ есть (вышел из канала, бан, перепривязка — снимаются)
  const mine = new Set(await groupChatIds(ws.data.userId));
  for (const id of [...(ws.data.watching ?? [])]) {
    if (mine.has(id)) continue;
    if (await canRead(sql, id, ws.data.userId).then(() => true, () => false)) mine.add(id);
    else ws.data.watching!.delete(id);
  }
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
  // исключён (бан) или вышел: и превью этого канала снимается — сверка не должна подписать снова
  for (const ws of socketsOf(userId)) {
    ws.data.watching?.delete(chatId); void unsubscribeChat(ws, chatId);
    // треды гостя через этот канал или в этой группе — тоже: доступа больше нет (вышел из канала, исключён)
    for (const [k, channel] of [...(ws.data.threads ?? [])]) {
      const [g, t] = k.split(':').map(Number);
      if (g === chatId || channel === chatId) unwatchThread(ws, g, t);
    }
  }
}

/**
 * Тред глазами гостя (не участник группы обсуждения, threads.ts threadAccess): сокет подписан на топик
 * `thread:<группа>:<копия>`, пока тред открыт. Кадры threadPush собирает realtime.ts из push группы — только события
 * этого треда. Счётчик открытых тредов по чатам — в процессе: realtime смотрит его, чтобы не разбирать push групп,
 * где гостей нет. Valkey не нужен: push каждый процесс собирает сам из NOTIFY журнала чата.
 */
const watched = new Map<number, Map<number, number>>();
export const threadTopic = (chatId: number, threadId: number) => `thread:${chatId}:${threadId}`;
/** Открытые гостями треды чата в этом процессе (id копий) или undefined. */
export const watchedThreads = (chatId: number): ReadonlyMap<number, number> | undefined => watched.get(chatId);

/** false — занято WATCH_MAX слотов (превью и треды вместе). */
export function watchThread(ws: ChatSocket, chatId: number, threadId: number, channelId: number): boolean {
  const map = (ws.data.threads ??= new Map()), k = chatId + ':' + threadId;
  if (map.has(k)) { map.set(k, channelId); return true; }
  if (watchSlots(ws) >= WATCH_MAX) return false;
  map.set(k, channelId);
  ws.subscribe(threadTopic(chatId, threadId));
  let by = watched.get(chatId);
  if (!by) watched.set(chatId, (by = new Map()));
  by.set(threadId, (by.get(threadId) ?? 0) + 1);
  return true;
}

export function unwatchThread(ws: ChatSocket, chatId: number, threadId: number): void {
  const k = chatId + ':' + threadId;
  if (!ws.data.threads?.delete(k)) return;
  ws.unsubscribe(threadTopic(chatId, threadId));
  const by = watched.get(chatId);
  const n = (by?.get(threadId) ?? 0) - 1;
  if (n > 0) by!.set(threadId, n);
  else { by?.delete(threadId); if (!by?.size) watched.delete(chatId); }
}

/** Сокет закрывается: снять его треды со счёта (топики Bun снимает сам). */
export function releaseThreads(ws: ChatSocket): void {
  for (const k of [...(ws.data.threads?.keys() ?? [])]) { const [c, t] = k.split(':').map(Number); unwatchThread(ws, c, t); }
}

/** Треды гостя сокета (only — только связанные с этим чатом: группа или канал доступа) — заново по threadAccess;
 *  доступа нет или я уже участник (тогда хватает топика чата) — снять. */
async function recheckSocketThreads(ws: ChatSocket, only?: number): Promise<void> {
  for (const [k, channel] of [...(ws.data.threads ?? [])]) {
    const [g, t] = k.split(':').map(Number);
    if (only != null && g !== only && channel !== only) continue;
    const ok = await threadAccess(sql, g, ws.data.userId, t).then((a) => a.guest?.channelId === channel, () => false);
    if (!ok) unwatchThread(ws, g, t);
  }
}

/** Информация чата изменилась (groupUpdated: перепривязка группы обсуждения, «только участники»…) — треды гостей
 *  этого процесса, связанные с ним, перепроверяются. */
export async function recheckThreads(chatId: number): Promise<void> {
  for (const set of byUser.values()) for (const ws of set) if (ws.data.threads?.size) await recheckSocketThreads(ws, chatId).catch((e) => console.error('thread recheck:', e));
}
