import type { ButtonAnswer, MessageButton } from '@relay/protocol';
import { sql } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';
import { confirmSession, terminateOthers, terminateSession } from './sessions';
import { LOGIN_GONE, LOGIN_OTHERS_ENDED, resolveLoginAlerts, systemUserId } from './service';

/**
 * Нажатие callback-кнопки под сообщением (как callback_query в Telegram): кнопка с такой data должна быть у этого
 * сообщения в чате, где пользователь участник. Кнопки пока шлёт только служебный «Relay» — их обрабатывает сам сервер;
 * ответ — тост, а итог (если он есть) правит сообщение и приходит всем устройствам журналом (messageMarkup).
 * sessionId — сеанс, с которого нажали: «завершить остальные» оставляет его.
 */
export async function pressButton(userId: number, sessionId: number, chatId: number, id: number, data: string): Promise<ButtonAnswer> {
  await assertMember(sql, chatId, userId);
  const [m] = await sql`select sender_id, deleted, buttons from messages where chat_id = ${chatId} and id = ${id}`;
  const rows = (m && !m.deleted ? m.buttons : null) as MessageButton[][] | null;
  if (!rows?.some((row) => row.some((b) => b.kind === 'callback' && b.data === data))) throw new DomainError('not_found', 'button');
  if (Number(m.sender_id) !== await systemUserId()) throw new DomainError('forbidden', 'button');
  const login = /^login:(ok|end|others):(\d{1,15})$/.exec(data);
  if (!login) throw new DomainError('not_found', 'button');
  return loginAction(userId, sessionId, login[1] as 'ok' | 'end' | 'others', Number(login[2]));
}

/** «Новый вход»: подтвердить, завершить его или все остальные. Отказ (свежий сеанс, сам себя) — тост без правки. */
async function loginAction(userId: number, sessionId: number, action: 'ok' | 'end' | 'others', sid: number): Promise<ButtonAnswer> {
  if (action !== 'others' && sid === sessionId) {
    return { toast: action === 'ok' ? 'Подтвердить вход можно только с другого устройства' : 'Это текущий сеанс — выйти можно в Настройках' };
  }
  try {
    if (action === 'ok') { await confirmSession(userId, sessionId, sid); return { toast: 'Вход подтверждён' }; }
    if (action === 'end') { await terminateSession(userId, sessionId, sid); return { toast: 'Сеанс завершён' }; }
    const { ids } = await terminateOthers(userId, sessionId);
    // «Новый вход» об этом самом устройстве: остальные завершены — вопрос закрыт
    if (sid === sessionId) await sql.begin((tx) => resolveLoginAlerts(tx, userId, [sid], LOGIN_OTHERS_ENDED));
    return { toast: ids.length ? `Завершено сеансов: ${ids.length}` : 'Других сеансов нет' };
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    if (e.code === 'fresh_session') return { toast: 'С нового устройства этого пока нельзя — сделайте это там, где вы вошли раньше' };
    if (e.code === 'not_found') {
      // сеанса уже нет (завершён раньше или вышел сам): кнопки убираем
      await sql.begin((tx) => resolveLoginAlerts(tx, userId, [sid], LOGIN_GONE));
      return { toast: 'Этот сеанс уже завершён' };
    }
    throw e;
  }
}
