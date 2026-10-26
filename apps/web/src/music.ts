import * as player from '@relay/ui/src/media/player.js';
import { useEffect, useState } from 'preact/hooks';
import { deviceStore, findOnDevice } from './mediaCache';
import { localPreview } from './data';
import { getGlobal, setGlobal } from './global';
import { Mirror } from '@relay/sync-engine/src/client';
import { addProfileMusic, removeProfileMusic, showToast, watchQuery } from './settingsData';
import { inOwnMusic, musicOf, type ProfileTrack } from './profileLists';
import { personName } from './people';

// Музыка: один трек на сообщение, где бы его ни включили (лента, «Общие медиа», плейлист, профиль) —
// ключ = ключ сообщения, поэтому кнопки везде показывают одно и то же состояние.

type Att = { id: string; name: string; duration?: number | null; title?: string | null; performer?: string | null; thumb?: string | null };
export type MusicMsg = { key?: string; clientId?: string; id?: number | null; chatId?: number; senderId?: number; attachment?: Att | null };
export type Track = { key: string; kind: 'music' | 'voice'; src: string; duration: number; title: string; performer?: string; subtitle?: string; chatId?: number; msgId?: number | null; attId?: string };

export const trackTitle = (name: string) => name.replace(/\.[^.]{1,5}$/, '');

function senderName(senderId: number | undefined): string {
  const g = getGlobal();
  if (senderId == null) return '';
  if (senderId === g.me?.userId) return g.me?.name ?? 'Вы';
  return personName(senderId);
}

export function musicTrack(m: MusicMsg, chatId: number): Track {
  const key = (m.key ?? m.clientId) as string;
  const a = m.attachment!;
  return { key, kind: 'music', src: localPreview(key) ?? `/files/${a.id}`, duration: a.duration ?? 0, title: a.title || trackTitle(a.name),
    performer: a.performer || senderName(m.senderId), chatId: m.chatId ?? chatId, msgId: m.id ?? null, attId: a.id };
}

/* ---------- файл трека в кэше ---------- */
// Плеер берёт файл кусками (Range) — такие ответы кэш не хранит. Как в Telegram, включённый трек скачиваем целиком
// в фоне: он попадает в кэш вложений (Service Worker), и значок «скачать» у пузыря больше не нужен.
const cached = new Map<string, boolean>();
const waiters = new Map<string, Set<(v: boolean) => void>>();
function setCached(path: string, v: boolean) { cached.set(path, v); waiters.get(path)?.forEach((f) => f(v)); }

async function checkCached(path: string): Promise<boolean> {
  const id = /^\/files\/([0-9a-f-]{36})$/.exec(path)?.[1];
  try { return !!id && !!(await findOnDevice(deviceStore(), id)); } catch { return false; }
}

function warm(src: string) {
  if (!/^\/files\/[0-9a-f-]{36}$/.test(src) || cached.get(src)) return;
  void fetch(src).then((r) => r.blob()).then(() => checkCached(src)).then((v) => { if (v) setCached(src, true); }).catch(() => {});
}

/** Есть ли файл вложения в кэше (для значка «скачать»); пока неизвестно — false. */
export function useFileCached(id: string | undefined): boolean {
  const path = id ? `/files/${id}` : '';
  const [v, setV] = useState(() => (path ? cached.get(path) ?? false : false));
  useEffect(() => {
    if (!path) return;
    let set = waiters.get(path);
    if (!set) waiters.set(path, (set = new Set()));
    set.add(setV);
    if (!cached.has(path)) void checkCached(path).then((x) => { if (!cached.get(path)) setCached(path, x); });
    else setV(cached.get(path)!);
    return () => { set!.delete(setV); };
  }, [path]);
  return v;
}

/** Играть (или пауза) трек; плейлист — переданный список (новые сверху: «дальше» — старее, как в Telegram). */
export function toggleMusic(m: MusicMsg, list: MusicMsg[], chatId: number): void {
  const tracks = list.filter((x) => x.attachment).map((x) => musicTrack(x, chatId));
  const t = musicTrack(m, chatId);
  const cur = player.playerState();
  if (cur.key !== t.key) player.setPlaylist(tracks);
  player.toggle(t);
  warm(t.src);
}

/* ---------- музыка в профиле ---------- */
export type { ProfileTrack };

/** Файл трека уже в моём профиле — по подписке движка (profileLists.ts), синхронно. */
export const inProfile = (t: Track) => inOwnMusic(t.attId);

export async function toggleProfileMusic(t: Track): Promise<void> {
  if (!t.attId) return;
  const had = inProfile(t);
  try {
    // движок ставит операцию в очередь и сразу показывает результат в подписке; отказ сервера откатит строку,
    // а тост об отказе покажет наблюдатель очереди (settingsData)
    if (had) await removeProfileMusic(t.attId);
    else if (t.chatId != null && t.msgId != null) {
      // сообщения нет в кэше движка — строки пока нет: «добавлено» не обещаем (список обновит ответ сервера)
      const r = (await addProfileMusic(t.chatId, t.msgId)) as { optimistic?: boolean } | null;
      if (r?.optimistic === false) return;
    } else return;
    showToast(had ? 'Трек убран из профиля' : 'Трек добавлен в профиль');
  } catch {
    showToast('Не удалось изменить музыку профиля');
  }
}

/** Треки чьего-то профиля → плейлист; играть с i-го и открыть окно плейлиста. */
const profileTrack = (userId: number, x: Pick<ProfileTrack, 'id' | 'title' | 'duration'>): Track =>
  ({ key: 'profile:' + userId + ':' + x.id, kind: 'music', src: `/files/${x.id}`, duration: x.duration ?? 0, title: x.title, performer: '', attId: x.id });

export function playProfile(userId: number, tracks: Pick<ProfileTrack, 'id' | 'title' | 'duration'>[], i = 0): void {
  const list: Track[] = tracks.map((x) => profileTrack(userId, x));
  if (!list.length) return;
  player.setPlaylist(list);
  player.play(list[i]);
  warm(list[i].src);
  setGlobal({ playlistOpen: true });
}

/** Плашка под аватаром знает только последний трек (PublicUser.music): он играет сразу, а весь список
 *  профиля приходит из подписки движка и становится плейлистом, если этот трек всё ещё играет. */
export function playProfileTop(userId: number, top: Pick<ProfileTrack, 'id' | 'title' | 'duration'>): void {
  playProfile(userId, [top]);
  const key = profileTrack(userId, top).key;
  const m = new Mirror();
  let done = false;
  const stop = () => { done = true; w.close(); clearTimeout(timer); };
  const timer = setTimeout(stop, 15_000);   // без связи ответа нет — подписку не копим
  const w = watchQuery({ kind: 'profileMusic', userId }, (p) => {
    if (done) return;
    m.apply(p);
    const v = musicOf(m);
    if (!v || (!v.loaded && !v.tracks.length)) return;
    if (v.tracks.length > 1 && player.playerState().key === key) player.setPlaylist(v.tracks.map((x) => profileTrack(userId, x)));
    done = true;
    queueMicrotask(stop);
  });
}
