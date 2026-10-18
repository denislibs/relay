import { ROUND_MAX_SECONDS, WAVEFORM_BYTES, type Attachment, type AttachmentKind } from '@relay/protocol';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../db';
import { DomainError } from './errors';

export const MAX_FILE = 50 * 1024 * 1024;
const dir = () => process.env.FILES_DIR ?? '/data/files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Сохранить загруженный файл. Ширина и высота — от клиента (он уже декодировал картинку), только для раскладки. */
const VOICE_MIME = /^audio\/(ogg|webm|mp4|mpeg|wav)$/;
const ROUND_MIME = /^video\/(mp4|webm)$/;
const MAX_VOICE_SECONDS = 4 * 3600;

/** Волна голосового: ровно 63 байта в base64 (иначе — без волны, клиент нарисует ровную). */
function cleanWaveform(raw: string | undefined): string | null {
  if (!raw || raw.length > 128) return null;
  try {
    const bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return bytes.length === WAVEFORM_BYTES ? bytes.toString('base64') : null;
  } catch { return null; }
}

export async function storeUpload(userId: number, body: ArrayBuffer, meta: { mime: string; name: string; w?: number; h?: number; kind?: string; duration?: number; waveform?: string }): Promise<Attachment> {
  if (!body.byteLength) throw new DomainError('bad_frame', 'empty file');
  if (body.byteLength > MAX_FILE) throw new DomainError('too_long');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) ? meta.mime : 'application/octet-stream';
  const name = (meta.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  // голосовое и кружок — только с подходящим типом файла и разумной длительностью; иначе это просто файл
  const seconds = Number.isFinite(meta.duration) ? Math.round(meta.duration!) : 0;
  const voice = meta.kind === 'voice' && VOICE_MIME.test(mime) && seconds >= 1 && seconds <= MAX_VOICE_SECONDS;
  const round = meta.kind === 'round' && ROUND_MIME.test(mime) && seconds >= 1 && seconds <= ROUND_MAX_SECONDS + 1 && !!meta.w && meta.w === meta.h;
  const isPhoto = !voice && !round && /^image\/(jpeg|png|webp|gif|avif)$/.test(mime) && !!meta.w && !!meta.h;
  const kind: AttachmentKind = voice ? 'voice' : round ? 'round' : isPhoto ? 'photo' : 'file';
  const sized = isPhoto || round;
  const w = sized ? Math.min(Math.max(Math.round(meta.w!), 1), 20000) : null;
  const h = sized ? Math.min(Math.max(Math.round(meta.h!), 1), 20000) : null;
  const duration = voice || round ? seconds : null;
  const waveform = voice ? cleanWaveform(meta.waveform) : null;
  const [row] = await sql`insert into attachments (owner_id, mime, name, size, width, height, kind, duration, waveform)
    values (${userId}, ${mime}, ${name}, ${body.byteLength}, ${w}, ${h}, ${kind}, ${duration}, ${waveform}) returning id`;
  await mkdir(dir(), { recursive: true });
  await Bun.write(join(dir(), row.id as string), body);
  return { id: row.id as string, kind, mime, name, size: body.byteLength, w, h, ...(duration ? { duration } : {}), ...(waveform ? { waveform } : {}) };
}

/** Вложение для отправки: только своё и только существующее. thumb — крошечное превью (data:image, до 4 КБ). */
export async function attachmentForSend(tx: typeof sql | Parameters<Parameters<typeof sql.begin>[0]>[0], userId: number, ref: { id: string; thumb?: string | null }): Promise<Attachment> {
  if (!UUID.test(ref.id)) throw new DomainError('bad_frame', 'attachment id');
  const [a] = await tx`select * from attachments where id = ${ref.id}`;
  if (!a || a.owner_id !== userId) throw new DomainError('not_found', 'attachment');
  const thumb = ref.thumb && ref.thumb.length <= 4096 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(ref.thumb) ? ref.thumb : null;
  const kind = ((a.kind as AttachmentKind | null) ?? (a.width ? 'photo' : 'file'));
  return { id: a.id as string, kind, mime: a.mime as string, name: a.name as string, size: Number(a.size), w: (a.width as number) ?? null, h: (a.height as number) ?? null, thumb,
    ...(a.duration ? { duration: a.duration as number } : {}), ...(a.waveform ? { waveform: a.waveform as string } : {}) };
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
