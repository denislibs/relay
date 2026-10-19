import { useEffect, useRef, useState } from 'preact/hooks';
import type { MediaTab } from '@relay/protocol';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Item, Patch } from '@relay/sync-engine/src/types';
import { watchQuery } from './settingsData';

export type MediaCounts = Record<MediaTab, number>;
export type MediaView = { items: Item[]; done: boolean; loading: boolean; counts: MediaCounts | null };

/** Страница вкладки: на столько поднимается limit подписки за раз. */
export const MEDIA_PAGE = 40;

/** Последний вид по чату и вкладке — только кэш отрисовки: повторное открытие рисуется сразу, без мигания. */
const last = new Map<string, MediaView>();
const keyOf = (chatId: number, tab: MediaTab) => chatId + ':' + tab;

/** Вид вкладки из зеркала подписки `media`; null — движок ещё ничего не отдал (нет ~media). */
export function mediaOf(m: Mirror): MediaView | null {
  const meta = m.meta('~media');
  if (!meta) return null;
  return { items: m.list(), done: meta.done === true, loading: meta.loading === true, counts: (meta.counts as MediaCounts | null) ?? null };
}

/**
 * «Общие медиа» чата — подписка движка (первый показ из IndexedDB, дальше журнал); без собственных запросов.
 * more() поднимает limit на страницу — движок сам догружает старее; counts приходят с любой вкладки.
 */
export function useMedia(chatId: number, tab: MediaTab): MediaView & { more(): void } {
  const [view, setView] = useState<MediaView | null>(() => last.get(keyOf(chatId, tab)) ?? null);
  const [limit, setLimit] = useState(MEDIA_PAGE);
  const watch = useRef<{ update(q: never): void; close(): void } | null>(null);
  const cur = useRef({ view, limit });
  cur.current = { view, limit };
  useEffect(() => {
    setView(last.get(keyOf(chatId, tab)) ?? null);
    setLimit(MEDIA_PAGE);
    const mirror = new Mirror();
    const w = watchQuery({ kind: 'media', chatId, tab, limit: MEDIA_PAGE }, (p: Patch) => {
      mirror.apply(p);
      const v = mediaOf(mirror);
      if (!v) return;
      if (v.items.length || !v.loading) last.set(keyOf(chatId, tab), v);   // пустой «ещё грузится» не затирает показанное
      setView(v);
    });
    watch.current = w as never;
    return () => { w.close(); watch.current = null; };
  }, [chatId, tab]);
  const more = () => {
    const { view: v, limit: l } = cur.current;
    // страница ещё в пути (меньше элементов, чем просили) или всё уже есть — поднимать нечего
    if (!v || v.done || v.loading || v.items.length < l) return;
    const next = l + MEDIA_PAGE;
    cur.current.limit = next;
    setLimit(next);
    (watch.current as { update?(q: unknown): void } | null)?.update?.({ kind: 'media', chatId, tab, limit: next } as never);
  };
  return { ...(view ?? { items: [], done: false, loading: true, counts: null }), more };
}
