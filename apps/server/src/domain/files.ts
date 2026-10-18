import { ROUND_MAX_SECONDS, WAVEFORM_BYTES, type Attachment, type AttachmentKind } from '@relay/protocol';
import { S3Client } from 'bun';
import { sql } from '../db';
import { DomainError } from './errors';

export const MAX_FILE = 50 * 1024 * 1024;
/** Срок подписанного PUT: проверяется в начале запроса, поэтому медленной загрузке 50 МБ хватает. Короткий — чтобы
 *  после подтверждения объект нельзя было долго перезаписывать по той же ссылке. */
const PUT_TTL = 5 * 60;
/** Срок подписанного GET (с). Тесты ставят 1, чтобы проверить истёкшую ссылку. */
let getTtl = 10 * 60;
export function setDownloadTtl(seconds: number): void { getTtl = seconds; }
export const downloadTtl = () => getTtl;

/**
 * Два клиента одного бакета: s3() ходит в хранилище из сервера (HEAD, DELETE) по внутреннему адресу,
 * publicS3() только подписывает ссылки для браузера — подпись включает хост, поэтому нужен адрес, видимый снаружи.
 */
let internal: S3Client | null = null, external: S3Client | null = null;
const s3opts = (endpoint: string | undefined) => ({
  accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  bucket: process.env.S3_BUCKET ?? 'relay-files', region: process.env.S3_REGION ?? 'us-east-1', endpoint,
});
export const s3 = () => (internal ??= new S3Client(s3opts(process.env.S3_ENDPOINT)));
const publicS3 = () => (external ??= new S3Client(s3opts(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Метаданные будущего вложения: тело идёт мимо сервера (подписанный PUT в S3), размер обещан заранее и сверяется при подтверждении.
 *  Ширина и высота — от клиента (он уже декодировал картинку), только для раскладки. */
export interface UploadMeta { mime: string; name: string; size: number; w?: number; h?: number; kind?: string; duration?: number; waveform?: string; title?: string; performer?: string }

/**
 * Шаг 1: запись pending и подписанный PUT на ключ = id. Подписан только хост (Bun.s3 не подписывает Content-Type и длину),
 * поэтому всё, что важно, проверяет confirmUpload по HEAD. mime в ответе — тот, с которым клиент обязан положить объект.
 */
export async function createUpload(userId: number, meta: UploadMeta): Promise<{ id: string; url: string; mime: string; expiresIn: number }> {
  if (!Number.isSafeInteger(meta.size) || meta.size <= 0) throw new DomainError('bad_frame', 'file size');
  if (meta.size > MAX_FILE) throw new DomainError('too_long');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) ? meta.mime.toLowerCase() : 'application/octet-stream';
  const name = (meta.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  // голосовое и кружок — только с подходящим типом файла и разумной длительностью; иначе это просто файл
  const seconds = Number.isFinite(meta.duration) ? Math.round(meta.duration!) : 0;
  const voice = meta.kind === 'voice' && VOICE_MIME.test(mime) && seconds >= 1 && seconds <= MAX_VOICE_SECONDS;
  const round = meta.kind === 'round' && ROUND_MIME.test(mime) && seconds >= 1 && seconds <= ROUND_MAX_SECONDS + 1 && !!meta.w && meta.w === meta.h;
  const isPhoto = !voice && !round && /^image\/(jpeg|png|webp|gif|avif)$/.test(mime) && !!meta.w && !!meta.h;
  // музыка: аудиофайл с длительностью (клиент её узнал, проиграв метаданные); голосовым он от этого не становится
  const audio = !voice && meta.kind === 'audio' && /^audio\//.test(mime) && seconds >= 1 && seconds <= 24 * 3600;
  const kind: AttachmentKind = voice ? 'voice' : round ? 'round' : isPhoto ? 'photo' : audio ? 'audio' : 'file';
  const sized = isPhoto || round;
  const w = sized ? Math.min(Math.max(Math.round(meta.w!), 1), 20000) : null;
  const h = sized ? Math.min(Math.max(Math.round(meta.h!), 1), 20000) : null;
  const duration = voice || round || audio ? seconds : null;
  const waveform = voice ? cleanWaveform(meta.waveform) : null;
  // название и исполнитель — только у музыки, без управляющих символов и не длиннее 200
  const tag = (v: unknown) => (audio && typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null : null);
  const [row] = await sql`insert into attachments (owner_id, mime, name, size, width, height, kind, duration, waveform, title, performer, status)
    values (${userId}, ${mime}, ${name}, ${meta.size}, ${w}, ${h}, ${kind}, ${duration}, ${waveform}, ${tag(meta.title)}, ${tag(meta.performer)}, 'pending') returning id`;
  const id = row.id as string;
  return { id, url: publicS3().presign(id, { method: 'PUT', expiresIn: PUT_TTL }), mime, expiresIn: PUT_TTL };
}

/**
 * Шаг 2: объект на месте, размер и тип те, что обещаны, — тогда вложение ready и его можно отправить.
 * Чужое и несуществующее — not_found (не выдаём, что id занят). Несовпадение — объект удаляется, клиент начинает заново.
 */
export async function confirmUpload(userId: number, id: string): Promise<Attachment> {
  if (!UUID.test(id)) throw new DomainError('not_found', 'attachment');
  const [a] = await sql`select * from attachments where id = ${id} and owner_id = ${userId}`;
  if (!a) throw new DomainError('not_found', 'attachment');
  if (a.status === 'ready') return attachmentOf(a, null);
  let stat: { size: number; type: string };
  try { stat = await s3().file(id).stat(); } catch { throw new DomainError('upload_missing'); }
  const type = stat.type.split(';')[0].trim().toLowerCase();
  if (stat.size !== Number(a.size) || stat.size > MAX_FILE || type !== a.mime) {
    await s3().delete(id).catch(() => {});
    throw new DomainError('upload_mismatch', `size ${stat.size}/${a.size}, type ${type}/${a.mime}`);
  }
  const [r] = await sql`update attachments set status = 'ready' where id = ${id} and status = 'pending' returning *`;
  return attachmentOf(r ?? a, null);
}

/** Вложение для отправки: только своё и только существующее. thumb — крошечное превью (data:image, до 4 КБ). */
export async function attachmentForSend(tx: typeof sql | Parameters<Parameters<typeof sql.begin>[0]>[0], userId: number, ref: { id: string; thumb?: string | null }): Promise<Attachment> {
  if (!UUID.test(ref.id)) throw new DomainError('bad_frame', 'attachment id');
  const [a] = await tx`select * from attachments where id = ${ref.id}`;
  if (!a || a.owner_id !== userId) throw new DomainError('not_found', 'attachment');
  if (a.status !== 'ready') throw new DomainError('upload_pending');
  const thumb = ref.thumb && ref.thumb.length <= 8192 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(ref.thumb) ? ref.thumb : null;
  return attachmentOf(a, thumb);
}

function attachmentOf(a: Record<string, unknown>, thumb: string | null): Attachment {
  const kind = ((a.kind as AttachmentKind | null) ?? (a.width ? 'photo' : 'file'));
  return { id: a.id as string, kind, mime: a.mime as string, name: a.name as string, size: Number(a.size), w: (a.width as number) ?? null, h: (a.height as number) ?? null, thumb,
    ...(a.duration ? { duration: a.duration as number } : {}), ...(a.waveform ? { waveform: a.waveform as string } : {}),
    ...(a.title ? { title: a.title as string } : {}), ...(a.performer ? { performer: a.performer as string } : {}) };
}

/** Файл для скачивания: владельцу и участникам чатов, где он отправлен. */
export async function fileFor(userId: number, id: string): Promise<{ id: string; mime: string; name: string } | null> {
  if (!UUID.test(id)) return null;
  const [a] = await sql`
    select a.* from attachments a
     where a.id = ${id} and a.status = 'ready'
       and (a.owner_id = ${userId} or exists (
         select 1 from messages m join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
          where m.attachment->>'id' = ${id} and not m.deleted)
       or exists (   -- трек в чьём-то профиле: его видят все, кого владелец не заблокировал
         select 1 from profile_music p where p.attachment_id = a.id
            and not exists (select 1 from blocks b where b.owner_id = p.user_id and b.user_id = ${userId}))
       or exists (   -- фото профиля: как и сам профиль — всем, кого владелец не заблокировал
         select 1 from users u where (u.photo->>'id' = ${id} or u.photo->>'small' = ${id}) and u.photo is not null
            and not exists (select 1 from blocks b where b.owner_id = u.id and b.user_id = ${userId})))`;
  return a ? { id, mime: a.mime as string, name: a.name as string } : null;
}

/**
 * Подписанный GET с коротким сроком: ссылку не храним нигде (ни в сообщении, ни в IndexedDB) — в данных только id,
 * за ссылкой каждый раз ходят в /files/:id. Тип и Content-Disposition задаёт подпись (response-*), а не то, что лежит
 * в объекте: HTML/SVG и прочее активное отдаётся как octet-stream вложением, даже если клиент положил его с другим типом.
 */
export function signedDownload(f: { id: string; mime: string; name: string }, opts: { inline: boolean }): string {
  const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  return publicS3().presign(f.id, { method: 'GET', expiresIn: getTtl, type: opts.inline ? f.mime : 'application/octet-stream', contentDisposition: disposition });
}

/** pending старше суток — брошенные загрузки: запись и объект (если клиент успел его положить) удаляем. */
export async function sweepPendingUploads(olderThanMs = 24 * 3600_000): Promise<number> {
  const rows = await sql`delete from attachments where status = 'pending' and created_at < now() - ${olderThanMs / 1000} * interval '1 second' returning id`;
  for (const r of rows) await s3().delete(r.id as string).catch(() => {});
  return rows.length;
}
