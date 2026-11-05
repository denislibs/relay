// Музыка и фото профиля — подписки движка (profileMusic, profilePhotos): первый показ из IndexedDB, дальше журнал;
// без собственных запросов. Своя музыка держится одной подпиской на всё время сеанса — кнопки плеера читают её синхронно.
import { useEffect, useState } from 'preact/hooks';
import { useKeyedState } from './keyedState';
import type { UserPhoto } from '@relay/protocol';
import { Mirror } from '@relay/sync-engine/src/client';
import type { Patch, Query } from '@relay/sync-engine/src/types';
import { watchQuery } from './settingsData';

type Watch = (q: Query, cb: (p: Patch) => void) => { close(): void };

export type ProfileTrack = { id: string; title: string; duration: number | null; mime: string };
export type MusicView = { tracks: ProfileTrack[]; loaded: boolean; loading: boolean };
export type PhotosView = { photos: UserPhoto[]; loaded: boolean; loading: boolean; total: number | null };

/** Вид из зеркала подписки profileMusic (треки новые сверху); null — движок ещё ничего не отдал. */
export function musicOf(m: Mirror): MusicView | null {
  const meta = m.meta('~profileMusic');
  if (!meta) return null;
  const tracks = m.list().map((i) => ({ id: i.attId as string, title: i.title as string, duration: (i.duration as number | null) ?? null, mime: i.mime as string }));
  return { tracks, loaded: meta.loaded === true, loading: meta.loading === true };
}

/** Вид из зеркала подписки profilePhotos (главное первым); null — движок ещё ничего не отдал. */
export function photosOf(m: Mirror): PhotosView | null {
  const meta = m.meta('~profilePhotos');
  if (!meta) return null;
  const photos = m.list().map((i) => ({ pid: i.pid, id: i.id, small: i.small, thumb: i.thumb, at: i.at, ...(i.video ? { video: i.video } : {}) }) as UserPhoto);
  return { photos, loaded: meta.loaded === true, loading: meta.loading === true, total: (meta.total as number | null) ?? null };
}

/* ---------- своя музыка (для кнопок «в профиль») ---------- */
let own = new Set<string>();
let ownWatch: { close(): void } | null = null;
const ownListeners = new Set<() => void>();

/** Подписка на свою музыку; повторный вызов (вход другим пользователем без перезагрузки) — с нуля. */
export function startOwnMusic(userId: number, watch: Watch = watchQuery): void {
  ownWatch?.close();
  ownWatch = null;
  resetProfileLists();
  const m = new Mirror();
  ownWatch = watch({ kind: 'profileMusic', userId }, (p) => {
    m.apply(p);
    const v = musicOf(m);
    if (!v) return;
    own = new Set(v.tracks.map((t) => t.id));
    for (const f of ownListeners) f();
  });
}

/** Файл уже в моём профиле (синхронно, по подписке). */
export const inOwnMusic = (attId: string | undefined): boolean => !!attId && own.has(attId);

/** Закрыть подписку на свою музыку (выход из аккаунта). */
export function stopOwnMusic(): void {
  ownWatch?.close();
  ownWatch = null;
  resetProfileLists();
}

/** Перерисовка при любом изменении своей музыки. */
export function useOwnMusic(): void {
  const [, setRev] = useState(0);
  useEffect(() => { const f = () => setRev((x) => x + 1); ownListeners.add(f); return () => { ownListeners.delete(f); }; }, []);
}

/* ---------- кэш отрисовки ---------- */
// Последний вид — только чтобы повторное открытие рисовалось сразу, без мигания; правда — в движке.
const musicLast = new Map<number, MusicView>();
const photosLast = new Map<number, PhotosView>();

/** Сброс кэшей отрисовки и своей музыки (смена пользователя без перезагрузки). */
export function resetProfileLists(): void {
  musicLast.clear();
  photosLast.clear();
  own = new Set();
  for (const f of ownListeners) f();
}

/** Музыка профиля человека; null — движок ещё не ответил и показывать нечего. */
export function useProfileMusic(userId: number | null | undefined): MusicView | null {
  const [v, setV] = useKeyedState<number | null | undefined, MusicView | null>(userId, (id) => (id ? musicLast.get(id) ?? null : null));
  useEffect(() => {
    setV(userId ? musicLast.get(userId) ?? null : null);
    if (!userId) return;
    const m = new Mirror();
    const w = watchQuery({ kind: 'profileMusic', userId }, (p) => {
      m.apply(p);
      const x = musicOf(m);
      if (!x) return;
      if (x.tracks.length || x.loaded) musicLast.set(userId, x);
      setV(x);
    });
    return () => w.close();
  }, [userId]);
  return v;
}

/** История фото профиля (главное первым) из подписки движка; null — ещё нет. Кэш отрисовки — по человеку: смена главного не схлопывает галерею. */
export function useProfilePhotoList(userId: number | null | undefined): UserPhoto[] | null {
  const [v, setV] = useKeyedState<number | null | undefined, PhotosView | null>(userId, (id) => (id ? photosLast.get(id) ?? null : null));
  useEffect(() => {
    setV(userId ? photosLast.get(userId) ?? null : null);
    if (!userId) return;
    const m = new Mirror();
    const w = watchQuery({ kind: 'profilePhotos', userId }, (p) => {
      m.apply(p);
      const x = photosOf(m);
      if (!x) return;
      if (x.photos.length || x.loaded) photosLast.set(userId, x);
      setV(x);
    });
    return () => w.close();
  }, [userId]);
  return v && v.photos.length ? v.photos : null;
}
