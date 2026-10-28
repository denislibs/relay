// Выбор нескольких чатов в списке слева — как в Telegram для Android: «Выбрать» в меню строки включает режим,
// клик по строке отмечает, шапка считает выбранное и предлагает то, что можно сделать со всеми сразу.
// Направление действия — то, что приводит все выбранные к одному состоянию; нельзя хоть с одним — пункта нет.
import type { MyMembership } from '@relay/protocol';
import { getGlobal, setGlobal } from './global';
import { PIN_LIMIT, hasUnreadMark, isArchived, isPinned } from './chatFlags';
import { isMuted } from './mute';
import { isSystemChat } from './ui/format';

export type SelList = 'main' | 'archive';
type Chat = Record<string, unknown>;

/** Что можно сделать с выбранным: нет ключа — пункта нет; значение — направление (pin: false — открепить, read: false — непрочитанные). */
export type SelActions = Partial<Record<'read' | 'pin' | 'mute' | 'archive' | 'delete', boolean>>;
export type SelState = { pinned: boolean; unread: boolean; muted: boolean; archived: boolean; system: boolean; owner: boolean };

export function stateOf(c: Chat, now = Date.now()): SelState {
  const me = (c.me as MyMembership | null | undefined) ?? null;
  return {
    pinned: isPinned(c), unread: (c.unread as number) > 0 || hasUnreadMark(c), muted: isMuted(c, now),
    archived: isArchived(c), system: isSystemChat(c),
    owner: (c.kind === 'group' || c.kind === 'channel') && me?.role === 'owner',
  };
}

export function selectionActions(list: SelState[]): SelActions {
  if (!list.length) return {};
  const a: SelActions = {
    read: list.some((s) => s.unread),
    pin: list.some((s) => !s.pinned),
    mute: !list.some((s) => s.muted),   // один без звука — включить звук всем (как в Android)
  };
  if (!list.some((s) => s.system)) a.archive = !list.some((s) => s.archived);
  if (!list.some((s) => s.system || s.owner)) a.delete = true;   // своя группа удаляется только целиком — не из списка
  return a;
}

const put = (list: SelList, ids: number[]) => setGlobal({ chatSelect: ids.length ? { list, ids } : null });

export function startChatSelect(list: SelList, id: number): void { put(list, [id]); }
export function toggleChatSelect(id: number): void {
  const s = getGlobal().chatSelect;
  if (s) put(s.list, s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id]);
}
/** Протяжка мышью задаёт набор целиком. */
export function setChatSelectIds(ids: number[]): void { const s = getGlobal().chatSelect; if (s) put(s.list, ids); }
export function endChatSelect(): void { if (getGlobal().chatSelect) setGlobal({ chatSelect: null }); }
/** Чат пропал из списка (удалён, ушёл в архив с другого устройства) — из выбора выпадает. */
export function pruneChatSelect(has: (id: number) => boolean): void {
  const s = getGlobal().chatSelect;
  if (s && !s.ids.every(has)) put(s.list, s.ids.filter(has));
}

/** Выбранные в порядке списка, сверху вниз. */
export function inListOrder(ids: readonly number[], list: readonly { id: unknown }[]): number[] {
  const set = new Set(ids);
  return list.map((c) => c.id as number).filter((id) => set.has(id));
}

/** Хватит ли места закрепить ids: у «Всех» и «Архива» лимит свой (chatFlags.PIN_LIMIT). */
export function pinRoom(ids: readonly number[], chats: readonly Chat[]): boolean {
  const byId = new Map(chats.map((c) => [c.id as number, c]));
  for (const archived of [false, true]) {
    const add = ids.filter((id) => { const c = byId.get(id); return c && !isPinned(c) && isArchived(c) === archived; }).length;
    if (add && chats.filter((c) => isPinned(c) && isArchived(c) === archived).length + add > PIN_LIMIT) return false;
  }
  return true;
}
