import type { Attachment } from '@relay/protocol';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../db';
import { DomainError } from './errors';

export const MAX_FILE = 50 * 1024 * 1024;
const dir = () => process.env.FILES_DIR ?? '/data/files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Сохранить загруженный файл. Ширина и высота — от клиента (он уже декодировал картинку), только для раскладки. */
export async function storeUpload(userId: number, body: ArrayBuffer, meta: { mime: string; name: string; w?: number; h?: number }): Promise<Attachment> {
  if (!body.byteLength) throw new DomainError('bad_frame', 'empty file');
  if (body.byteLength > MAX_FILE) throw new DomainError('too_long');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) ? meta.mime : 'application/octet-stream';
  const name = (meta.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  const isPhoto = /^image\/(jpeg|png|webp|gif|avif)$/.test(mime) && !!meta.w && !!meta.h;
  const w = isPhoto ? Math.min(Math.max(Math.round(meta.w!), 1), 20000) : null;
  const h = isPhoto ? Math.min(Math.max(Math.round(meta.h!), 1), 20000) : null;
  const [row] = await sql`insert into attachments (owner_id, mime, name, size, width, height) values (${userId}, ${mime}, ${name}, ${body.byteLength}, ${w}, ${h}) returning id`;
  await mkdir(dir(), { recursive: true });
  await Bun.write(join(dir(), row.id as string), body);
  return { id: row.id as string, kind: isPhoto ? 'photo' : 'file', mime, name, size: body.byteLength, w, h };
}

/** Вложение для отправки: только своё и только существующее. thumb — крошечное превью (data:image, до 4 КБ). */
export async function attachmentForSend(tx: typeof sql | Parameters<Parameters<typeof sql.begin>[0]>[0], userId: number, ref: { id: string; thumb?: string | null }): Promise<Attachment> {
  if (!UUID.test(ref.id)) throw new DomainError('bad_frame', 'attachment id');
  const [a] = await tx`select * from attachments where id = ${ref.id}`;
  if (!a || a.owner_id !== userId) throw new DomainError('not_found', 'attachment');
  const thumb = ref.thumb && ref.thumb.length <= 4096 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(ref.thumb) ? ref.thumb : null;
  return { id: a.id as string, kind: a.width ? 'photo' : 'file', mime: a.mime as string, name: a.name as string, size: Number(a.size), w: (a.width as number) ?? null, h: (a.height as number) ?? null, thumb };
}

/** Файл для скачивания: владельцу и участникам чатов, где он отправлен. */
export async function fileFor(userId: number, id: string): Promise<{ path: string; mime: string; name: string } | null> {
  if (!UUID.test(id)) return null;
  const [a] = await sql`
    select a.* from attachments a
     where a.id = ${id}
       and (a.owner_id = ${userId} or exists (
         select 1 from messages m join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
          where m.attachment->>'id' = ${id} and not m.deleted))`;
  return a ? { path: join(dir(), id), mime: a.mime as string, name: a.name as string } : null;
}
