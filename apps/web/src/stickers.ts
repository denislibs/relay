// Стикеры в интерфейсе: вызовы движка (мои паки, паки, отправка) и открытие модалки пака.
// Движок отдаёт data.ts через bindStickers — здесь своя тонкая обёртка, чтобы стикеры не разрастались в data.ts.
import type { MyStickers, StickerRef, StickerSet, StickerSetInfo } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { setGlobal, useGlobal } from './global';

type Call = (a: Record<string, unknown> & { type: string }) => Promise<unknown>;
let call: Call = () => Promise.reject(new Error('engine is not ready'));

/** data.ts передаёт вызов движка при старте. */
export function bindStickers(fn: Call): void { call = fn; }

export const EMPTY_MINE: MyStickers = { sets: [], recent: [], faved: [] };

export const loadMyStickers = () => call({ type: 'myStickers' }) as Promise<MyStickers & { offline?: boolean }>;
export const loadStickerSet = (id: number | string, hash?: string) => call({ type: 'stickerSet', id, ...(hash ? { hash } : {}) }) as Promise<StickerSet | null>;
export const featuredSets = (offset = 0) => call({ type: 'featuredStickerSets', offset }) as Promise<StickerSetInfo[]>;
export const searchSets = (q: string) => call({ type: 'searchStickerSets', q }) as Promise<StickerSetInfo[]>;
export const stickersByEmoji = (emoji: string) => call({ type: 'stickersByEmoji', emoji }) as Promise<StickerRef[]>;
export const installSet = (setId: number, on: boolean, info?: StickerSetInfo) => call({ type: 'installStickerSet', setId, on, ...(info ? { info } : {}) });
export const faveSticker = (s: StickerRef, on: boolean) => call({ type: 'faveSticker', id: s.id, on, sticker: s });
export const clearRecentStickers = (id?: number) => call({ type: 'clearRecentStickers', ...(id != null ? { id } : {}) });
export const sendSticker = (chatId: number, sticker: StickerRef, replyToId?: number | null) => call({ type: 'sendSticker', chatId, sticker, replyToId: replyToId ?? null });

/** Мои стикеры, свежие: перечитываются, когда движок поднимает stickersRev (журнал, переподключение, свои действия). */
export function useMyStickers(): MyStickers {
  const rev = useGlobal((s) => (s.status as { stickersRev?: number }).stickersRev ?? 0);
  const [mine, setMine] = useState<MyStickers>(lastMine);
  useEffect(() => {
    let live = true;
    loadMyStickers().then((m) => { if (live) { lastMine = m; setMine(m); } }, () => {});
    return () => { live = false; };
  }, [rev]);
  return mine;
}
let lastMine: MyStickers = EMPTY_MINE;

/** Куда уходит стикер, выбранный в модалке или правой панели: открытый чат и его текущий ответ (ставит Chat). */
type Target = { chatId: number; replyId: () => number | null; sent: () => void };
let target: Target | null = null;
export function setStickerTarget(t: Target | null): () => void {
  target = t;
  return () => { if (target === t) target = null; };
}
export const hasStickerTarget = () => !!target;
/** Отправить в открытый чат (с ответом, если он выбран). false — чата нет. */
export function sendStickerHere(s: StickerRef): boolean {
  if (!target) return false;
  void sendSticker(target.chatId, s, target.replyId());
  target.sent();
  return true;
}

/** Модалка пака (клик по стикеру в ленте, панель, правая панель). Модуль грузится при первом открытии. */
export function openStickerSet(idOrShort: number | string): void {
  void import('./ui/stickers/StickerSetModal').then((m) => m.showStickerSet(idOrShort));
}

/** «Стикеры» (из поиска в панели эмодзи) — страница правой панели «Информация», вторая вложенность. */
export function openStickersPanel(): void { setGlobal({ infoOpen: true, infoGo: 'stickers' }); }
