// Приветствие в пустом личном чате (как в Telegram): карточка «Сообщений пока нет…» и стикер, который можно
// отправить одним нажатием. Здесь — только правило «когда показывать»; стикер — stickers.ts, вид — ui/GreetingCard.
import type { FeedMeta } from './global';

/** Чат, в котором бывает приветствие: личный, не служебный «Relay», не с самим собой, не тред и не заблокирован. */
export function greetingChat(chat: Record<string, unknown> | null | undefined, meId: number, o: { thread: boolean; blocked: boolean }): boolean {
  if (!chat || chat.kind !== 'direct' || o.thread || o.blocked || chat.preview) return false;
  if ((chat.peer as { system?: boolean } | null | undefined)?.system) return false;
  return chat.peerId != null && chat.peerId !== meId;
}

/**
 * История пуста наверняка: окно ленты пришло (meta), за его краями ничего нет и в нём ни одного сообщения.
 * Пока первая страница не подтверждена сервером, у окна hasOlder — карточка не мелькает перед перепиской.
 */
export function historyEmpty(meta: FeedMeta | null | undefined, count: number): boolean {
  return !!meta && !meta.hasOlder && !meta.hasNewer && count === 0;
}
