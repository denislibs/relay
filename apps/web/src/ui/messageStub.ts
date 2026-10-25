import type { Item } from '@relay/sync-engine/src/types';

/** Типы, которые лента умеет рисовать; остальное пришло от более новой версии сервера. */
const KNOWN_KINDS = new Set(['text', 'photo', 'video', 'file', 'voice', 'round', 'audio', 'todo', 'sticker', 'poll', 'contact', 'geo', 'dice']);

/**
 * Заглушка вместо пустого пузыря (как «не поддерживается» в Telegram): неизвестный тип — просим обновиться;
 * известный, но без содержимого (сервер не смог его открыть: ключ чата уничтожен, нет снимка стикера) — «недоступно».
 * null — сообщение нормальное, рисуем как обычно.
 */
export function unsupportedText(m: Item): string | null {
  const kind = String(m.kind ?? 'text');
  if (!KNOWN_KINDS.has(kind)) return 'Это сообщение не поддерживается вашей версией Relay. Обновите приложение.';
  if ((m.service as { type?: string } | undefined)?.type) return null;
  const blank = !String(m.body ?? '').trim() && !m.blocks && !m.buttons && !m.link;
  if (!blank) return null;
  if (kind === 'sticker' && !m.sticker) return 'Стикер недоступен';
  if (kind === 'todo' && !m.todo) return 'Чек-лист недоступен';
  if (kind === 'poll' && !m.poll) return 'Опрос недоступен';
  if (kind === 'contact' && !m.contact) return 'Контакт недоступен';
  if (kind === 'geo' && !m.geo) return 'Геопозиция недоступна';
  if (kind === 'dice' && !m.dice) return 'Сообщение недоступно';
  if (kind === 'text') return 'Сообщение недоступно';
  return null;
}
