import { player } from '@relay/ui';
import { localPreview } from './data';
import { getGlobal, setGlobal } from './global';
import { showToast } from './settingsData';

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
  return g.names[senderId] ?? '';
}

export function musicTrack(m: MusicMsg, chatId: number): Track {
  const key = (m.key ?? m.clientId) as string;
  const a = m.attachment!;
  return { key, kind: 'music', src: localPreview(key) ?? `/files/${a.id}`, duration: a.duration ?? 0, title: a.title || trackTitle(a.name),
    performer: a.performer || senderName(m.senderId), chatId: m.chatId ?? chatId, msgId: m.id ?? null, attId: a.id };
}

/** Играть (или пауза) трек; плейлист — переданный список (новые сверху: «дальше» — старее, как в Telegram). */
export function toggleMusic(m: MusicMsg, list: MusicMsg[], chatId: number): void {
  const tracks = list.filter((x) => x.attachment).map((x) => musicTrack(x, chatId));
  const t = musicTrack(m, chatId);
  const cur = player.playerState();
  if (cur.key !== t.key) player.setPlaylist(tracks);
  player.toggle(t);
}

/* ---------- музыка в профиле ---------- */
export type ProfileTrack = { id: string; title: string; duration: number | null; mime: string };

export async function loadProfileMusic(userId: number): Promise<ProfileTrack[]> {
  const r = await fetch(`/users/${userId}/music`);
  if (!r.ok) throw new Error('music ' + r.status);
  return ((await r.json()) as { tracks: ProfileTrack[] }).tracks;
}

/** Мои треки в профиле — для кнопки «Добавить/Убрать» в плеере (при старте и после каждой правки). */
export async function refreshMyMusic(): Promise<void> {
  const me = getGlobal().me?.userId;
  if (!me) return;
  try { setGlobal({ myMusic: (await loadProfileMusic(me)).map((t) => t.id) }); } catch { /* без сети — позже */ }
}

export const inProfile = (t: Track) => !!t.attId && getGlobal().myMusic.includes(t.attId);

export async function toggleProfileMusic(t: Track): Promise<void> {
  if (!t.attId) return;
  const had = inProfile(t);
  // сразу, как в Telegram; не вышло — откатываем
  setGlobal((s) => ({ myMusic: had ? s.myMusic.filter((x) => x !== t.attId) : [t.attId!, ...s.myMusic] }));
  try {
    const r = had ? await fetch(`/me/music/${t.attId}`, { method: 'DELETE' })
      : await fetch('/me/music', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: t.chatId, messageId: t.msgId }) });
    if (!r.ok) throw new Error(String(r.status));
    setGlobal({ myMusic: ((await r.json()) as { tracks: ProfileTrack[] }).tracks.map((x) => x.id) });
    showToast(had ? 'Трек убран из профиля' : 'Трек добавлен в профиль');
  } catch {
    setGlobal((s) => ({ myMusic: had ? [t.attId!, ...s.myMusic] : s.myMusic.filter((x) => x !== t.attId) }));
    showToast('Не удалось изменить музыку профиля');
  }
}

/** Треки чьего-то профиля → плейлист; играть с i-го и открыть окно плейлиста. */
export function playProfile(userId: number, tracks: ProfileTrack[], i = 0): void {
  const list: Track[] = tracks.map((x) => ({ key: 'profile:' + userId + ':' + x.id, kind: 'music', src: `/files/${x.id}`, duration: x.duration ?? 0, title: x.title, performer: '', attId: x.id }));
  if (!list.length) return;
  player.setPlaylist(list);
  player.play(list[i]);
  setGlobal({ playlistOpen: true });
}
