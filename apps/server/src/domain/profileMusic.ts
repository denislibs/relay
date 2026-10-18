import { sql } from '../db';
import { assertMember } from './chats';
import { DomainError } from './errors';

// Музыка в профиле: человек добавляет трек из чата, где он участник; видят все, кого он не заблокировал.
// Файл трека после этого доступен и тем, кто видит профиль (fileFor), — как в Telegram.

export const PROFILE_MUSIC_MAX = 100;

export interface ProfileTrack { id: string; title: string; duration: number | null; mime: string; addedAt: string }

export async function listProfileMusic(viewer: number, userId: number): Promise<ProfileTrack[]> {
  const [blocked] = await sql`select 1 from blocks where owner_id = ${userId} and user_id = ${viewer}`;
  if (blocked && viewer !== userId) return [];
  const rows = await sql`
    select p.attachment_id, p.title, p.duration, a.mime, p.added_at from profile_music p join attachments a on a.id = p.attachment_id
     where p.user_id = ${userId} and a.status = 'ready' order by p.added_at desc limit ${PROFILE_MUSIC_MAX}`;
  return rows.map((r) => ({ id: r.attachment_id as string, title: r.title as string, duration: (r.duration as number) ?? null, mime: r.mime as string, addedAt: new Date(r.added_at as string).toISOString() }));
}

/** Добавить трек из сообщения: только музыка из своего чата; повтор — без ошибки. */
export async function addProfileMusic(userId: number, chatId: number, messageId: number): Promise<ProfileTrack[]> {
  await assertMember(sql, chatId, userId);
  const [m] = await sql`select attachment from messages where chat_id = ${chatId} and id = ${messageId} and not deleted and kind = 'audio'`;
  const att = m?.attachment as { id: string; name: string; duration?: number } | undefined;
  if (!att?.id) throw new DomainError('not_found', 'track');
  const [{ n }] = await sql`select count(*)::int as n from profile_music where user_id = ${userId}`;
  if (n >= PROFILE_MUSIC_MAX) throw new DomainError('too_long', 'profile music limit');
  await sql`insert into profile_music (user_id, attachment_id, title, duration)
    values (${userId}, ${att.id}, ${att.name.replace(/\.[^.]{1,5}$/, '').slice(0, 200)}, ${att.duration ?? null}) on conflict do nothing`;
  return listProfileMusic(userId, userId);
}

export async function removeProfileMusic(userId: number, attachmentId: string): Promise<ProfileTrack[]> {
  if (!/^[0-9a-f-]{36}$/.test(attachmentId)) throw new DomainError('bad_frame');
  await sql`delete from profile_music where user_id = ${userId} and attachment_id = ${attachmentId}`;
  return listProfileMusic(userId, userId);
}
