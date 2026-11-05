import { useEffect, useRef, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import type { MediaCounts as ProtocolMediaCounts, MediaTab } from '@relay/protocol';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch } from '@relay/sync-engine/src/types';
import { watchQuery } from './settingsData';

export type MediaCounts = ProtocolMediaCounts;
export type MediaView = { items: Item[]; done: boolean; loading: boolean; counts: MediaCounts | null };

/** Страница вкладки: на столько поднимается limit подписки за раз. */
export const MEDIA_PAGE = 40;

/** Последний вид по чату и вкладке — только кэш отрисовки: повторное открытие рисуется сразу, без мигания. */
const last = new Map<string, MediaView>();
const keyOf = (chatId: number, tab: MediaTab, page: number) => chatId + ':' + tab + (page ? '' : ':counts');   // счётчики-только не затирают кэш вкладки
export const cachedMedia = (chatId: number, tab: MediaTab, page = MEDIA_PAGE): MediaView | null => last.get(keyOf(chatId, tab, page)) ?? null;
export const rememberMedia = (chatId: number, tab: MediaTab, page: number, v: MediaView): void => { last.set(keyOf(chatId, tab, page), v); };
/** Выход и вход другим пользователем без перезагрузки: медиа прежнего аккаунта не показываются. */
export function resetMediaTabs(): void { last.clear(); }

/** Вид вкладки из зеркала подписки `media`; null — движок ещё ничего не отдал (нет ~media). */
export function mediaOf(m: Mirror): MediaView | null {
  const meta = m.meta('~media');
  if (!meta) return null;
  return { items: m.list(), done: meta.done === true, loading: meta.loading === true, counts: (meta.counts as MediaCounts | null) ?? null };
}

/**
 * «Общие медиа» чата — подписка движка (первый показ из IndexedDB, дальше журнал); без собственных запросов.
 * page — размер страницы и начальный limit; 0 — только счётчики (элементов нет, вкладка не грузится).
 * more() поднимает limit на страницу — движок сам догружает старее; counts приходят с любой вкладки.
 */
export function useMedia(chatId: number, tab: MediaTab, page = MEDIA_PAGE): MediaView & { more(): void } {
  const key = keyOf(chatId, tab, page);
  const [view, setView] = useKeyedState<string, MediaView | null>(key, () => cachedMedia(chatId, tab, page));
  const [limit, setLimit] = useKeyedState<string, number>(key, () => page);
  const watch = useRef<ReturnType<typeof watchQuery> | null>(null);
  const cur = useRef({ view, limit });
  cur.current = { view, limit };
  useEffect(() => {
    setView(cachedMedia(chatId, tab, page));
    setLimit(page);
    const mirror = new Mirror();
    const w = watchQuery({ kind: 'media', chatId, tab, limit: page }, (p: Patch) => {
      mirror.apply(p);
      const v = mediaOf(mirror);
      if (!v) return;
      if (v.items.length || !v.loading) rememberMedia(chatId, tab, page, v);   // пустой «ещё грузится» не затирает показанное
      setView(v);
    });
    watch.current = w;
    return () => { w.close(); watch.current = null; };
  }, [chatId, tab, page]);
  const more = () => {
    const { view: v, limit: l } = cur.current;
    // страница ещё в пути (меньше элементов, чем просили) или всё уже есть — поднимать нечего
    if (!page || !v || v.done || v.loading || v.items.length < l) return;
    const next = l + page;
    cur.current.limit = next;
    setLimit(next);
    watch.current?.update({ kind: 'media', chatId, tab, limit: next });
  };
  return { ...(view ?? { items: [], done: false, loading: true, counts: null }), more };
}
