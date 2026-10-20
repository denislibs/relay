// Фото профиля: свои — загрузка (обрезанное в AvatarCropper 640 + 160 + превью) и удаление;
// чужие — откуда брать картинку для Avatar. Файлы — обычные /files/<id>: их кэширует service worker (relay-media).
import type { ProfilePhoto, UserPhoto } from '@relay/protocol';
import { getGlobal, type Me } from './global';
import { useProfilePhotoList } from './profileLists';
import { refreshProfilePhotos } from './settingsData';

/** Пропсы Avatar для фото: маленькое — для списков, большое (big) — для профиля. Нет фото — пусто (инициалы). */
export function avatarPhoto(p: ProfilePhoto | null | undefined, big = false): { src?: string; thumb?: string } {
  return p ? { src: `/files/${big ? p.id : p.small}`, thumb: p.thumb } : {};
}

/** Фото человека для аватарки по id — единое место для всех аватарок людей. Откуда (сначала самое свежее):
 *  своё — из профиля; остальные — из подписки people (движок обновляет её по журналу userUpdated; если человек там есть,
 *  берём его фото, даже пустое); пока people ещё не пришли — фото из личного чата с ним, затем из списка контактов.
 *  Кто показывает человека, тот и просит его wantPeople (см. people.ts): собеседники, авторы, контакты — сразу с данными. */
export function userPhoto(userId: number | null | undefined): ProfilePhoto | null {
  if (userId == null) return null;
  const g = getGlobal();
  if (g.me?.userId === userId) return g.me.photo ?? null;
  const person = g.people[userId];
  if (person) return person.photo ?? null;
  const chat = g.chats.find((c) => c.kind === 'direct' && c.peerId === userId);
  if (chat && chat.photo !== undefined) return (chat.photo as ProfilePhoto | null) ?? null;
  const contact = g.contacts.find((c) => c.userId === userId);
  if (contact && contact.photo !== undefined) return (contact.photo as ProfilePhoto | null) ?? null;
  return null;
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
  void refreshProfilePhotos();   // сводка видит только главное; список — перечитать
  return me;
}

/** Удалить фото: без pid — главное, с pid — любое из истории. */
export async function removeProfilePhoto(pid?: number): Promise<Me> {
  const me = await json(await fetch(pid ? `/me/photos/${pid}` : '/me/photo', { method: 'DELETE', credentials: 'include' }));
  void refreshProfilePhotos();   // удалили не главное — сводка не изменилась, список перечитать
  return me;
}

export async function setMainPhoto(pid: number): Promise<Me> {
  const me = await json(await fetch(`/me/photos/${pid}/main`, { method: 'PUT', credentials: 'include' }));
  void refreshProfilePhotos();
  return me;
}

// ---------- история фото ----------
// Список — подписка движка (profileLists.ts): чужое — по журналу (userUpdated), своё — после правки зовём refreshProfilePhotos.

/**
 * История фото профиля (главное первым). Пока не загрузилась — одно главное фото из профиля,
 * чтобы шапка не мигала; без фото — пусто.
 */
export function useProfilePhotos(userId: number | null | undefined, main: ProfilePhoto | null | undefined): UserPhoto[] {
  const list = useProfilePhotoList(main ? userId : null);
  if (!main) return [];
  return list ?? [{ pid: main.pid ?? 0, id: main.id, small: main.small, thumb: main.thumb, at: main.at, ...(main.video ? { video: main.video } : {}) }];
}
