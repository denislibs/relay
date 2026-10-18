// Фото профиля: свои — загрузка (обрезанное в AvatarCropper 640 + 160 + превью) и удаление;
// чужие — откуда брать картинку для Avatar. Файлы — обычные /files/<id>: их кэширует service worker (relay-media).
import type { ProfilePhoto } from '@relay/protocol';
import type { Me } from './global';

/** Пропсы Avatar для фото: маленькое — для списков, большое (big) — для профиля. Нет фото — пусто (инициалы). */
export function avatarPhoto(p: ProfilePhoto | null | undefined, big = false): { src?: string; thumb?: string } {
  return p ? { src: `/files/${big ? p.id : p.small}`, thumb: p.thumb } : {};
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { code?: string } | null)?.code ?? 'upload');
  return r.json() as Promise<T>;
}

/** Три шага загрузки, как у вложений: заявка → PUT прямо в хранилище → подтверждение. */
async function upload(blob: Blob, side: number): Promise<string> {
  const intent = await post<{ id: string; url: string; mime: string }>('/uploads', { name: 'photo.jpg', mime: 'image/jpeg', size: blob.size, w: side, h: side });
  const put = await fetch(intent.url, { method: 'PUT', body: blob, headers: { 'content-type': intent.mime } });
  if (!put.ok) throw new Error('upload');
  return (await post<{ id: string }>(`/uploads/${intent.id}/confirm`)).id;
}

async function json(r: Response): Promise<Me> {
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { code?: string } | null)?.code ?? 'photo');
  return r.json() as Promise<Me>;
}

/** Поставить фото. Собеседники получат его через журнал (userUpdated), свой профиль — тоже. */
export async function setProfilePhoto(c: { big: Blob; small: Blob; thumb: string }): Promise<Me> {
  const [id, small] = await Promise.all([upload(c.big, 640), upload(c.small, 160)]);
  return json(await fetch('/me/photo', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, small, thumb: c.thumb }) }));
}

export async function removeProfilePhoto(): Promise<Me> {
  return json(await fetch('/me/photo', { method: 'DELETE', credentials: 'include' }));
}
