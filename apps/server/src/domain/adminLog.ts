import { ADMIN_LOG_RETENTION_HOURS, type AdminLogAction, type AdminLogData } from '@relay/protocol';
import { sql, type Tx } from '../db';

/**
 * Журнал действий админов («Недавние действия», таблица admin_log). Запись — только здесь и только в транзакции самого
 * изменения (Tx, не sql): откатилось действие — нет и записи, упала запись — нет и действия. Порядок записей одной
 * транзакции — порядок вызовов (id из последовательности). Повтор без изменений записи не даёт: вызывают только на
 * настоящей смене значения. Личные чаты сюда не пишутся (проверка в самой вставке).
 *
 * Что хранится (docs/SECURITY.md): названия и описание открыты и в chats, поэтому и здесь; текста сообщений нет ни в какой форме,
 * только ссылка по id; токен ссылки-приглашения — только маской. Имена — по id при чтении (adminLogRead.ts).
 */
export async function logAdminAction<A extends AdminLogAction>(tx: Tx, chatId: number, actorId: number | null, action: A, data: AdminLogData[A]): Promise<void> {
  await tx`insert into admin_log (chat_id, actor_id, action, data)
           select id, ${actorId}, ${action}, ${tx.json(data as never)} from chats where id = ${chatId} and kind in ('group', 'channel') and deleted_at is null`;
}

/** Маска токена ссылки: хватает узнать её в списке ссылок, войти по ней нельзя (остаток — 72 случайных бита). */
export const maskInvite = (token: string): string => token.slice(0, 4) + '…';

/** Срок вышел: пачками, чтобы не держать таблицу одним большим удалением. Возвращает, сколько удалено. */
export async function trimAdminLog(batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await sql`delete from admin_log where id in (select id from admin_log where at <= now() - make_interval(hours => ${ADMIN_LOG_RETENTION_HOURS}) limit ${batch})`;
    total += r.count;
    if (r.count < batch) return total;
  }
}
