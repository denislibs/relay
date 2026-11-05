import { sql } from '../db';
import { DomainError } from './errors';
import { canChangeInfo, groupCtx, isCommunity } from './groupRights';
import { chatEvent } from './journal';
import { blockedInDirect } from './privacy';
import { serviceMessage } from './groups';
import { themeById } from './themes';

/**
 * Тема чата: id готовой темы из каталога или null — снять. Личный чат — любой из двоих (не служебный, без блокировки);
 * группа и канал — тот, кто меняет информацию о группе. Служебное «X изменил(а) тему чата на 🐥» и событие chatTheme —
 * всем участникам (в личном — в журналы обоих).
 */
export async function setChatTheme(userId: number, chatId: number, raw: unknown): Promise<{ ok: true }> {
  if (raw !== null && (typeof raw !== 'string' || !themeById(raw))) throw new DomainError('bad_frame', 'theme');
  const theme = raw as string | null;
  return sql.begin(async (tx) => {
    const [c] = await tx`
      select c.kind, c.theme, c.deleted_at,
             exists (select 1 from chat_members o join users u on u.id = o.user_id where o.chat_id = c.id and u.system) as system
        from chats c join chat_members m on m.chat_id = c.id and m.user_id = ${userId}
       where c.id = ${chatId} for update of c`;
    if (!c) throw new DomainError('not_member');
    if (c.deleted_at) throw new DomainError('not_found', 'chat');
    const kind = c.kind as 'direct' | 'group' | 'channel';
    if (kind === 'direct') {
      if (c.system) throw new DomainError('forbidden', 'theme');   // служебный чат «Relay»
      if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    } else {
      const ctx = await groupCtx(tx, chatId, userId, { lock: true });
      isCommunity(ctx);
      if (!canChangeInfo(ctx)) throw new DomainError('forbidden', 'info');
    }
    if ((c.theme ?? null) === theme) return { ok: true };
    await tx`update chats set theme = ${theme} where id = ${chatId}`;
    const t = theme ? themeById(theme)! : null;
    await serviceMessage(tx, chatId, userId, 'theme_changed', t ? { emoji: t.emoji, title: t.title } : {}, '', kind);
    await chatEvent(tx, chatId, { type: 'chatTheme', chatId, theme }, kind);
    return { ok: true };
  });
}
