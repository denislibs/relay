import { sql, type Tx } from '../db';

type Db = Tx | typeof sql;
let systemId: Promise<number> | null = null;

/** Системный пользователь «Relay» (строка из миграции 108). Кэшируется на процесс. */
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
