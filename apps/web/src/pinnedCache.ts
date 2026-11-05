import type { Item } from '@relay/sync-engine/src/types';

/** Закреплённые сообщения, которых нет в ленте чата: chatId:id → сообщение (плашка под шапкой берёт текст отсюда). */
const cache = new Map<string, Item>();
export const cachedPinned = (chatId: number, id: number): Item | undefined => cache.get(chatId + ':' + id);
export function rememberPinned(chatId: number, items: Item[]): void { for (const m of items) cache.set(chatId + ':' + (m.id as number), m); }
export function resetPinned(): void { cache.clear(); }

/** Промис, который закончится не позже ms: ждём данных для плашки, но смену чата не держим дольше. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); p.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); }); });
}
