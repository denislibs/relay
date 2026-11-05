import { peerKeyOk } from '../crypto/peerKey';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { openRows } from './messageContent';

/**
 * Ссылка клиента на человека — как InputUser в Telegram:
 *   {id, key} — ключ доступа (crypto/peerKey.ts), выданный этому зрителю;
 *   {id, via: {chatId, messageId}} — «человек из этого сообщения» (как inputUserFromMessage): ключа у клиента может
 *     не быть (карточка контакта, «переслано от»), но сообщение он видит — и человек в нём назван.
 * Неверная ссылка — not_found, ровно как несуществующий человек: иначе это снова оракул перебора.
 */
export async function resolvePeer(db: Tx | typeof sql, viewer: number, ref: unknown, what = 'peer'): Promise<number> {
  const r = ref as { id?: unknown; userId?: unknown; key?: unknown; via?: { chatId?: unknown; messageId?: unknown } } | null;
  if (!r || typeof r !== 'object') throw new DomainError('bad_frame', what);
  const id = Number(r.id ?? r.userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new DomainError('bad_frame', what);
  if (r.key !== undefined) {
    if (!peerKeyOk(viewer, id, r.key)) throw new DomainError('not_found', what);
    return id;
  }
  if (id === viewer) return id;
  const chatId = Number(r.via?.chatId), messageId = Number(r.via?.messageId);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || chatId <= 0 || messageId <= 0) throw new DomainError('not_found', what);
  // сообщение видно зрителю (участник, не раньше его истории, не удалено, чат жив) и называет этого человека:
  // карточка контакта, «переслано от» или автор (не пост канала — он от имени канала)
  const [m] = await db`
    select m.* from messages m
      join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${viewer} and m.id >= cm.history_from
      join chats c on c.id = m.chat_id and c.deleted_at is null
     where m.chat_id = ${chatId} and m.id = ${messageId} and not m.deleted`;
  if (!m) throw new DomainError('not_found', what);
  if (Number(m.sender_id) === id && !m.post) return id;
  if (Number((m.fwd_from as { userId?: unknown } | null)?.userId) === id) return id;
  if (m.kind === 'contact') {
    await openRows([m]);   // карточка — в шифре сообщения (messageContent.ts)
    if (Number((m.data as { userId?: unknown } | null)?.userId) === id) return id;
  }
  throw new DomainError('not_found', what);
}

/** Список ссылок (участники новой группы, добавление в группу, исключения приватности). Не больше max. */
export async function resolvePeers(db: Tx | typeof sql, viewer: number, refs: unknown, max: number, what = 'peer'): Promise<number[]> {
  if (!Array.isArray(refs) || refs.length > max) throw new DomainError(Array.isArray(refs) ? 'too_long' : 'bad_frame', what);
  const out: number[] = [];
  for (const ref of refs) out.push(await resolvePeer(db, viewer, ref, what));
  return [...new Set(out)];
}
