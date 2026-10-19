// Фото профиля: свои — загрузка (обрезанное в AvatarCropper 640 + 160 + превью) и удаление;
// чужие — откуда брать картинку для Avatar. Файлы — обычные /files/<id>: их кэширует service worker (relay-media).
import type { ProfilePhoto, UserPhoto } from '@relay/protocol';
import { useEffect, useState } from 'preact/hooks';
import { getGlobal, type Me } from './global';

/** Пропсы Avatar для фото: маленькое — для списков, большое (big) — для профиля. Нет фото — пусто (инициалы). */
export function avatarPhoto(p: ProfilePhoto | null | undefined, big = false): { src?: string; thumb?: string } {
  return p ? { src: `/files/${big ? p.id : p.small}`, thumb: p.thumb } : {};
}

/** Фото человека для аватарки по id — единое место для всех аватарок людей. Откуда (сначала самое свежее):
 *  своё — из профиля; собеседник — из личного чата с ним; контакт — из списка контактов; остальные (авторы в группах,
 *  участники) — из подписки people (см. people.ts: кто показывает человека, тот и просит его wantPeople). */
export function userPhoto(userId: number | null | undefined): ProfilePhoto | null {
  if (userId == null) return null;
  const g = getGlobal();
  if (g.me?.userId === userId) return g.me.photo ?? null;
  const chat = g.chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  if (chat && chat.photo !== undefined) return (chat.photo as ProfilePhoto | null) ?? null;
  const contact = g.contacts.find((c) => c.userId === userId);
  if (contact && contact.photo !== undefined) return (contact.photo as ProfilePhoto | null) ?? null;
  return g.people[userId]?.photo ?? null;
}
/** То же для ChatRow (у него пропсы avatarSrc/avatarThumb). */
export function rowAvatar(p: ProfilePhoto | null | undefined): { avatarSrc?: string; avatarThumb?: string } { const a = avatarPhoto(p); return { avatarSrc: a.src, avatarThumb: a.thumb }; }
export function senderAvatar(userId: number | null | undefined): { src?: string; thumb?: string } {
  return avatarPhoto(userPhoto(userId));
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { code?: string } | null)?.code ?? 'upload');
  return r.json() as Promise<T>;
}

/** Три шага загрузки, как у вложений: заявка → PUT прямо в хранилище → подтверждение.
 *  Видео-аватарка идёт как квадратное видео (kind round): сервер запомнит сторону и длительность. */
export async function upload(blob: Blob, side: number, video?: { duration: number }): Promise<string> {
  const meta = video
    ? { name: 'avatar.' + (blob.type.includes('mp4') ? 'mp4' : 'webm'), mime: blob.type.split(';')[0], size: blob.size, w: side, h: side, kind: 'round', duration: Math.max(1, Math.round(video.duration)) }
    : { name: 'photo.jpg', mime: 'image/jpeg', size: blob.size, w: side, h: side };
  const intent = await post<{ id: string; url: string; mime: string }>('/uploads', meta);
  const put = await fetch(intent.url, { method: 'PUT', body: blob, headers: { 'content-type': intent.mime } });
  if (!put.ok) throw new Error('upload');
  return (await post<{ id: string }>(`/uploads/${intent.id}/confirm`)).id;
}

async function json(r: Response): Promise<Me> {
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { code?: string } | null)?.code ?? 'photo');
  return r.json() as Promise<Me>;
}

/** Поставить фото. Собеседники получат его через журнал (userUpdated), свой профиль — тоже. */
export async function setProfilePhoto(c: { big: Blob; small: Blob; thumb: string; video?: { blob: Blob; side: number; duration: number } }): Promise<Me> {
  const [id, small, video] = await Promise.all([upload(c.big, 640), upload(c.small, 160), c.video ? upload(c.video.blob, c.video.side, c.video) : undefined]);
  const me = await json(await fetch('/me/photo', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, small, thumb: c.thumb, ...(video ? { video } : {}) }) }));
  invalidatePhotos(me.userId);
  return me;
}

/** Удалить фото: без pid — главное, с pid — любое из истории. */
export async function removeProfilePhoto(pid?: number): Promise<Me> {
  const me = await json(await fetch(pid ? `/me/photos/${pid}` : '/me/photo', { method: 'DELETE', credentials: 'include' }));
  invalidatePhotos(me.userId);
  return me;
}

export async function setMainPhoto(pid: number): Promise<Me> {
  const me = await json(await fetch(`/me/photos/${pid}/main`, { method: 'PUT', credentials: 'include' }));
  invalidatePhotos(me.userId);
  return me;
}

// ---------- история фото: кэш на сессию вкладки ----------
// Ключ — человек + его главное фото: сменилось главное (userUpdated) — история перечитается сама.
const cache = new Map<string, Promise<UserPhoto[]>>();
const listeners = new Set<() => void>();
function invalidatePhotos(userId: number): void {
  for (const k of [...cache.keys()]) if (k.startsWith(userId + ':')) cache.delete(k);
  for (const f of listeners) f();
}
function load(userId: number, key: string): Promise<UserPhoto[]> {
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/users/${userId}/photos?limit=100`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { photos: [] }))
      .then((j: { photos: UserPhoto[] }) => j.photos, () => { cache.delete(key); return []; });
    cache.set(key, p);
  }
  return p;
}

/**
 * История фото профиля (главное первым). Пока не загрузилась — одно главное фото из профиля,
 * чтобы шапка не мигала; без фото — пусто.
 */
export function useProfilePhotos(userId: number | null | undefined, main: ProfilePhoto | null | undefined): UserPhoto[] {
  const key = userId ? `${userId}:${main?.pid ?? main?.id ?? 'none'}` : '';
  const fallback: UserPhoto[] = main ? [{ pid: main.pid ?? 0, id: main.id, small: main.small, thumb: main.thumb, at: main.at, ...(main.video ? { video: main.video } : {}) }] : [];
  const [list, setList] = useState<{ key: string; photos: UserPhoto[] } | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { const f = () => setRev((x) => x + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    if (!userId || !main) { setList(null); return; }
    let live = true;
    void load(userId, key).then((photos) => { if (live) setList({ key, photos }); });
    return () => { live = false; };
  }, [key, rev]);
  if (!main) return [];
  return list && list.key === key && list.photos.length ? list.photos : fallback;
}
