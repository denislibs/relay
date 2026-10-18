import type { Entity, Message, ServiceType } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { toMessage } from './chats';
import { fanOut } from './journal';
import { pushInBackground } from './push';

type Db = Tx | typeof sql;
let systemId: Promise<number> | null = null;

/** Системный пользователь «Relay» (строка из миграции 110_service). Кэшируется на процесс. */
export function systemUserId(): Promise<number> {
  return systemId ??= sql`select id from users where system limit 1`.then(([r]) => {
    if (!r) throw new Error('system user missing: run migrations');
    return Number(r.id);
  }).catch((e) => { systemId = null; throw e; });
}

/** Служебный чат пользователя: создаётся при первом служебном сообщении, дальше один и тот же. */
export async function serviceChatId(db: Db, userId: number): Promise<number> {
  const [found] = await db`select chat_id from service_chats where user_id = ${userId}`;
  if (found) return Number(found.chat_id);
  const sys = await systemUserId();
  const [chat] = await db`insert into chats (kind, title) values ('direct', null) returning id`;
  await db`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId}), (${chat.id}, ${sys})`;
  // гонка двух первых сообщений: побеждает первая вставка, лишний чат удаляем
  const [won] = await db`insert into service_chats (user_id, chat_id) values (${userId}, ${chat.id}) on conflict (user_id) do nothing returning chat_id`;
  if (won) return Number(won.chat_id);
  await db`delete from chats where id = ${chat.id}`;
  const [r] = await db`select chat_id from service_chats where user_id = ${userId}`;
  return Number(r.chat_id);
}

export async function isServiceChat(db: Db, chatId: number): Promise<boolean> {
  const [r] = await db`select 1 from service_chats where chat_id = ${chatId}`;
  return !!r;
}

/** Служебное сообщение пользователю: обычная строка messages + newMessage в журнал (синхронизация как у всех).
 *  Push здесь не уходит: вызывающий после коммита своей транзакции зовёт pushService(message). */
export async function postService(tx: Tx, userId: number, msg: { type: ServiceType; body: string; entities?: Entity[] }): Promise<Message> {
  const chatId = await serviceChatId(tx, userId);
  const sys = await systemUserId();
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, entities, service_type)
    values (${chatId}, ${sys}, ${crypto.randomUUID()}, 'text', ${msg.body}, ${msg.entities?.length ? tx.json(msg.entities as never) : null}, ${msg.type})
    returning *`;
  const message = toMessage(row);
  await fanOut(tx, [userId], { type: 'newMessage', message });
  return message;
}

/** Web Push служебного сообщения — только после коммита транзакции, в которой был postService. */
export function pushService(message: Message): void {
  pushInBackground(message);
}

/** «Новый вход»: устройство, IP и время, совет, что делать, если это не вы; заголовок жирным. */
export function newLoginMessage(device: string, ip: string | null, at: Date): { body: string; entities: Entity[] } {
  const when = at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const title = 'Новый вход в аккаунт';
  const body = `${title}\n\nУстройство: ${device}\nIP: ${ip ?? 'неизвестен'}\nВремя: ${when}\n\nЕсли это были не вы, откройте Настройки → Активные сеансы и завершите этот сеанс.`;
  return { body, entities: [{ type: 'bold', offset: 0, length: title.length }] };
}
