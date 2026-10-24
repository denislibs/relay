import { encryptedSize } from '@relay/protocol';
import { fileKey, openAttachmentRows, sealMeta, storeFileKey } from '../crypto/fileKeys';
import { MAX_FILE_BYTES, ROUND_MAX_SECONDS, WAVEFORM_BYTES, type Attachment, type AttachmentKind, type VideoVariant } from '@relay/protocol';
import { S3Client } from 'bun';
import { abortMultipart, completeMultipart, createMultipart, listMultipart, listParts, presignPart, type S3Conf } from './s3multipart';
import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { wantsPhotoPreview } from '../jobs/photo';
import { DomainError } from './errors';
import { checkUploadAllowed } from './uploadLimits';

export const MAX_FILE = MAX_FILE_BYTES;
/** Срок подписанного PUT: проверяется в начале запроса, поэтому и многоминутной загрузке 2 ГБ хватает. Короткий — чтобы
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
/** То же для multipart (s3multipart.ts): у Bun.S3Client этих вызовов нет. */
const s3conf = (endpoint: string | undefined): S3Conf => {
  const o = s3opts(endpoint);
  return { endpoint: o.endpoint ?? `https://s3.${o.region}.amazonaws.com`, bucket: o.bucket, region: o.region, accessKeyId: o.accessKeyId ?? '', secretAccessKey: o.secretAccessKey ?? '' };
};
const mpInternal = () => s3conf(process.env.S3_ENDPOINT);
const mpPublic = () => s3conf(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT);

/**
 * Большой файл (от 32 МБ) грузится частями, как в Telegram: обрыв посреди 2 ГБ теряет только недогруженные части.
 * Части 8 МБ (больше 512 МБ — 16 МБ): кусок, который не жалко перегрузить, и не больше 10 000 частей (предел S3).
 * Тесты уменьшают пороги (S3 требует от части не меньше 5 МБ, кроме последней).
 */
let multipartFrom = 32 * 1024 * 1024;
let partOverride: number | null = null;
const partBytes = (size: number) => partOverride ?? (size > 512 * 1024 * 1024 ? 16 : 8) * 1024 * 1024;
export function setMultipart(from: number, part: number | null): void { multipartFrom = from; partOverride = part; }
/** Срок ссылки на часть: проверяется в начале запроса; клиент берёт ссылки пачками перед самой загрузкой, истёкшую — заново. */
const PART_TTL = 30 * 60;
/** Сколько ссылок на части за один запрос. */
const PARTS_PER_REQUEST = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VOICE_MIME = /^audio\/(ogg|webm|mp4|mpeg|wav)$/;
const ROUND_MIME = /^video\/(mp4|webm)$/;
/** Видео, которое браузеры играют сами: только оно идёт медиа (кадр, длительность, играет в ленте); прочее — файлом. */
const VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/;
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
export interface UploadMeta { mime: string; name: string; size: number; w?: number; h?: number; kind?: string; duration?: number; waveform?: string; title?: string; performer?: string;
  /** 1 — клиент шифрует файл (fileCrypto.ts); key — ключ файла base64 (32 байта): сервер хранит его завёрнутым KMS */
  enc?: number; key?: string }

/** Объект в хранилище: у зашифрованного — больше исходного (заголовок и теги кусков) и всегда octet-stream. */
const objectSize = (a: { size: unknown; enc?: unknown }) => (Number(a.enc) === 1 ? encryptedSize(Number(a.size)) : Number(a.size));
const objectMime = (a: { mime: unknown; enc?: unknown }) => (Number(a.enc) === 1 ? 'application/octet-stream' : a.mime as string);
function parseFileKey(meta: UploadMeta): Uint8Array | null {
  if (meta.enc !== 1 || typeof meta.key !== 'string') return null;
  try { const raw = new Uint8Array(Buffer.from(meta.key, 'base64')); return raw.length === 32 ? raw : null; } catch { return null; }
}

/**
 * Шаг 1: запись pending и подписанный PUT на ключ = id. Подписан только хост (Bun.s3 не подписывает Content-Type и длину),
 * поэтому всё, что важно, проверяет confirmUpload по HEAD. mime в ответе — тот, с которым клиент обязан положить объект.
 */
export async function createUpload(userId: number, meta: UploadMeta): Promise<{ id: string; url?: string; mime: string; expiresIn: number; multipart?: { partSize: number; parts: number } }> {
  if (!Number.isSafeInteger(meta.size) || meta.size <= 0) throw new DomainError('bad_frame', 'file size');
  if (meta.size > MAX_FILE) throw new DomainError('file_too_big');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(meta.mime) ? meta.mime.toLowerCase() : 'application/octet-stream';
  const name = (meta.name || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
  // голосовое и кружок — только с подходящим типом файла и разумной длительностью; иначе это просто файл
  const seconds = Number.isFinite(meta.duration) ? Math.round(meta.duration!) : 0;
  const voice = meta.kind === 'voice' && VOICE_MIME.test(mime) && seconds >= 1 && seconds <= MAX_VOICE_SECONDS;
  const round = meta.kind === 'round' && ROUND_MIME.test(mime) && seconds >= 1 && seconds <= ROUND_MAX_SECONDS + 1 && !!meta.w && meta.w === meta.h;
  // видео как медиа: клиент знает размеры кадра и длительность (проиграл метаданные); «отправить как файл» — kind не передаёт
  const video = !voice && !round && meta.kind === 'video' && VIDEO_MIME.test(mime) && !!meta.w && !!meta.h && seconds >= 0 && seconds <= 24 * 3600;
  const isPhoto = !voice && !round && !video && /^image\/(jpeg|png|webp|gif|avif)$/.test(mime) && !!meta.w && !!meta.h;
  // музыка: аудиофайл с длительностью (клиент её узнал, проиграв метаданные); голосовым он от этого не становится
  const audio = !voice && meta.kind === 'audio' && /^audio\//.test(mime) && seconds >= 1 && seconds <= 24 * 3600;
  const kind: AttachmentKind = voice ? 'voice' : round ? 'round' : video ? 'video' : isPhoto ? 'photo' : audio ? 'audio' : 'file';
  const sized = isPhoto || round || video;
  const w = sized ? Math.min(Math.max(Math.round(meta.w!), 1), 20000) : null;
  const h = sized ? Math.min(Math.max(Math.round(meta.h!), 1), 20000) : null;
  const duration = voice || round || audio || video ? seconds : null;
  const waveform = voice ? cleanWaveform(meta.waveform) : null;
  // название и исполнитель — только у музыки, без управляющих символов и не длиннее 200
  const tag = (v: unknown) => (audio && typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) || null : null);
  // пределы на пользователя (число идущих загрузок, байты за час и сутки, flood) — после проверки заявки: кривая квоту не тратит
  await checkUploadAllowed(userId, meta.size);
  // зашифрованный на клиенте: ключ файла — завёрнутым KMS в keys.attachment_keys, имя/название/исполнитель — шифром им же
  const fileKeyRaw = parseFileKey(meta);
  if (meta.enc === 1 && !fileKeyRaw) throw new DomainError('bad_frame', 'file key');
  const id = crypto.randomUUID();
  const enc = fileKeyRaw ? 1 : 0;
  const sealedMeta = fileKeyRaw ? await sealMeta(id, fileKeyRaw, { name, title: tag(meta.title), performer: tag(meta.performer) }) : null;
  await sql.begin(async (tx) => {
    await tx`insert into attachments (id, owner_id, mime, name, size, width, height, kind, duration, waveform, title, performer, status, enc, meta)
      values (${id}, ${userId}, ${mime}, ${fileKeyRaw ? '' : name}, ${meta.size}, ${w}, ${h}, ${kind}, ${duration}, ${waveform}, ${fileKeyRaw ? null : tag(meta.title)}, ${fileKeyRaw ? null : tag(meta.performer)}, 'pending', ${enc}, ${sealedMeta})`;
    if (fileKeyRaw) await storeFileKey(tx, id, fileKeyRaw);
  });
  const size = objectSize({ size: meta.size, enc }), type = objectMime({ mime, enc });
  if (size < multipartFrom) return { id, url: publicS3().presign(id, { method: 'PUT', expiresIn: PUT_TTL }), mime: type, expiresIn: PUT_TTL };
  // большой: загрузка частями — тип объекта задаётся здесь, ссылки на части клиент берёт в uploadParts
  let uploadId: string;
  try { uploadId = await createMultipart(mpInternal(), id, type); }
  catch (e) { await sql`delete from attachments where id = ${id}`; throw e; }
  await sql`update attachments set upload_id = ${uploadId} where id = ${id}`;
  const partSize = partBytes(size);
  return { id, mime: type, expiresIn: PART_TTL, multipart: { partSize, parts: Math.ceil(size / partSize) } };
}

/** Pending-загрузка частями этого пользователя: строка и разбивка на части (размер части выводится из размера файла). */
async function multipartOf(userId: number, id: string) {
  if (!UUID.test(id)) throw new DomainError('not_found', 'attachment');
  const [a] = await sql`select id, size, enc, upload_id from attachments where id = ${id} and owner_id = ${userId} and status = 'pending'`;
  if (!a?.upload_id) throw new DomainError('not_found', 'attachment');
  const size = objectSize(a), partSize = partBytes(size);
  return { id, uploadId: a.upload_id as string, size, partSize, parts: Math.ceil(size / partSize) };
}

/** Подписанные PUT на части (номера с 1). Повтор того же номера перезаписывает часть — так клиент перегружает оборванную. */
export async function uploadParts(userId: number, id: string, numbers: unknown): Promise<{ urls: Record<number, string>; expiresIn: number }> {
  const m = await multipartOf(userId, id);
  if (!Array.isArray(numbers) || numbers.length === 0 || numbers.length > PARTS_PER_REQUEST
    || !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= m.parts)) throw new DomainError('bad_frame', 'parts');
  const pub = mpPublic(), urls: Record<number, string> = {};
  for (const n of numbers as number[]) urls[n] = presignPart(pub, id, m.uploadId, n, PART_TTL);
  return { urls, expiresIn: PART_TTL };
}

/** Какие части хранилище уже приняло (правильного размера): клиент сверяется, если его список разошёлся с сервером. */
export async function uploadStatus(userId: number, id: string): Promise<{ partSize: number; parts: number; done: number[] }> {
  const m = await multipartOf(userId, id);
  return { partSize: m.partSize, parts: m.parts, done: (await goodParts(m)).map((p) => p.n) };
}
async function goodParts(m: { id: string; uploadId: string; size: number; partSize: number; parts: number }) {
  const all = await listParts(mpInternal(), m.id, m.uploadId);
  const want = (n: number) => (n < m.parts ? m.partSize : m.size - m.partSize * (m.parts - 1));
  return all.filter((p) => p.n >= 1 && p.n <= m.parts && p.size === want(p.n));
}

/** confirm для загрузки частями: все части на месте → CompleteMultipartUpload; дальше обычная проверка объекта по HEAD. */
async function completeUpload(a: Record<string, unknown>): Promise<void> {
  const id = a.id as string, size = objectSize(a), partSize = partBytes(size);
  const m = { id, uploadId: a.upload_id as string, size, partSize, parts: Math.ceil(size / partSize) };
  let parts: { n: number; etag: string }[];
  try { parts = await goodParts(m); }
  catch (e) {
    // уже собран (прошлый confirm оборвался после Complete): загрузки нет, а объект есть — проверит HEAD
    if ((e as { s3Code?: string }).s3Code === 'NoSuchUpload') { await sql`update attachments set upload_id = null where id = ${id}`; return; }
    throw e;
  }
  if (parts.length !== m.parts) throw new DomainError('upload_incomplete', `${parts.length}/${m.parts} parts`);
  await completeMultipart(mpInternal(), id, m.uploadId, parts);
  await sql`update attachments set upload_id = null where id = ${id}`;
}

/** Отмена загрузки владельцем (сообщение удалили из очереди): части и запись — сразу, а не через сутки. Готовое не трогаем. */
export async function abortUpload(userId: number, id: string): Promise<void> {
  if (!UUID.test(id)) return;
  const [a] = await sql`delete from attachments where id = ${id} and owner_id = ${userId} and status = 'pending' returning id, upload_id`;
  if (!a) return;
  if (a.upload_id) await abortMultipart(mpInternal(), id, a.upload_id as string).catch(() => {});
  await s3().delete(id).catch(() => {});
}

/**
 * Шаг 2: объект на месте, размер и тип те, что обещаны, — тогда вложение ready и его можно отправить.
 * Чужое и несуществующее — not_found (не выдаём, что id занят). Несовпадение — объект удаляется, клиент начинает заново.
 */
export async function confirmUpload(userId: number, id: string): Promise<Attachment> {
  if (!UUID.test(id)) throw new DomainError('not_found', 'attachment');
  const [a] = await sql`select * from attachments where id = ${id} and owner_id = ${userId}`;
  if (!a) throw new DomainError('not_found', 'attachment');
  await openAttachmentRows([a]);
  if (a.status === 'ready') return attachmentOf(a, null, await variantsOf(sql, id));
  if (a.upload_id) await completeUpload(a);
  let stat: { size: number; type: string };
  try { stat = await s3().file(id).stat(); } catch { throw new DomainError('upload_missing'); }
  const type = stat.type.split(';')[0].trim().toLowerCase();
  if (stat.size !== objectSize(a) || Number(a.size) > MAX_FILE || type !== objectMime(a)) {
    await s3().delete(id).catch(() => {});
    throw new DomainError('upload_mismatch', `size ${stat.size}/${objectSize(a)}, type ${type}/${objectMime(a)}`);
  }
  // видео-медиа: перепаковка (faststart), ролик для ленты и 720p — в воркере; до конца обработки играет оригинал.
  // фото и картинка-файл: уменьшенная копия для сетки — тоже в воркере; до неё плитка грузит оригинал
  const r = await sql.begin(async (tx) => {
    const [row] = await tx`update attachments set status = 'ready' where id = ${id} and status = 'pending' returning *`;
    if (row?.kind === 'video') await enqueue(tx, 'video.process', { id }, { dedupeKey: `video.process:${id}`, maxAttempts: 3 });
    else if (row && wantsPhotoPreview(row)) await enqueue(tx, 'photo.process', { id }, { dedupeKey: `photo.process:${id}`, maxAttempts: 3 });
    return row;
  });
  if (r) await openAttachmentRows([r]);
  return attachmentOf(r ?? a, null);
}

/** Вложение для отправки: только своё и только существующее. thumb — крошечное превью (data:image, до 4 КБ). */
export async function attachmentForSend(tx: typeof sql | Parameters<Parameters<typeof sql.begin>[0]>[0], userId: number, ref: { id: string; thumb?: string | null; spoiler?: boolean }): Promise<Attachment> {
  if (!UUID.test(ref.id)) throw new DomainError('bad_frame', 'attachment id');
  // for share: обработка видео (jobs/video.ts) обновляет строку и снимки в сообщениях под for update — не разминуться с ней
  const [a] = await tx`select * from attachments where id = ${ref.id} for share`;
  // своё вложение — или трек из своей музыки профиля (его могли добавить из чужого сообщения): «Музыка» в скрепке
  const mine = a && (a.owner_id === userId || (await tx`select 1 from profile_music where user_id = ${userId} and attachment_id = ${a.id}`).length > 0);
  if (!a || !mine) throw new DomainError('not_found', 'attachment');
  if (a.status !== 'ready') throw new DomainError('upload_pending');
  const thumb = ref.thumb && ref.thumb.length <= 8192 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(ref.thumb) ? ref.thumb : null;
  await openAttachmentRows([a], tx);
  const out = attachmentOf(a, thumb, await variantsOf(tx, a.id as string));
  // зашифрованный файл: ключ — в само вложение сообщения (запечатается ключом чата вместе с текстом)
  if (Number(a.enc) === 1) { const raw = await fileKey(a.id as string, tx); if (raw) out.key = Buffer.from(raw).toString('base64'); }
  // спойлер — только у фото и видео (у файла и голосового его нечем показать)
  return ref.spoiler === true && (out.kind === 'photo' || out.kind === 'video') ? { ...out, spoiler: true } : out;
}

type Db = typeof sql | Parameters<Parameters<typeof sql.begin>[0]>[0];

/** Копии видео и превью фото из attachment_variants (пусто — ещё не обработано или обрабатывать нечего). */
export async function variantsOf(db: Db, id: string): Promise<VideoVariant[]> {
  const rows = await db`select name, width, height, size from attachment_variants where attachment_id = ${id} order by name`;
  return rows.map((v) => ({ name: v.name as VideoVariant['name'], w: v.width as number, h: v.height as number, size: Number(v.size) }));
}

export function attachmentOf(a: Record<string, unknown>, thumb: string | null, variants: VideoVariant[] = []): Attachment {
  const kind = ((a.kind as AttachmentKind | null) ?? (a.width ? 'photo' : 'file'));
  const preview = variants.find((v) => v.name === 'preview');
  const rest = variants.filter((v) => v.name !== 'preview');
  return { id: a.id as string, kind, mime: a.mime as string, name: a.name as string, size: Number(a.size), w: (a.width as number) ?? null, h: (a.height as number) ?? null, thumb,
    ...(a.duration ? { duration: a.duration as number } : {}), ...(a.waveform ? { waveform: a.waveform as string } : {}),
    ...(a.title ? { title: a.title as string } : {}), ...(a.performer ? { performer: a.performer as string } : {}),
    ...(preview ? { preview } : {}), ...(rest.length ? { variants: rest } : {}), ...(Number(a.enc) === 1 ? { enc: 1 as const } : {}) };
}

/** Файл для скачивания: владельцу и участникам чатов, где он отправлен. key — объект в бакете (после перепаковки — не id);
 *  variant — копия видео (preview, 720) или фото (preview, medium): права те же, что у оригинала. */
export interface StoredFile { id: string; key: string; mime: string; name: string }
export async function fileFor(userId: number, id: string, variant?: string): Promise<StoredFile | null> {
  if (!UUID.test(id)) return null;
  const [a] = await sql`
    select a.* from attachments a
     where a.id = ${id} and a.status = 'ready'
       and (a.owner_id = ${userId} or exists (
         select 1 from messages m join chat_members cm on cm.chat_id = m.chat_id and cm.user_id = ${userId}
                                  join chats c on c.id = m.chat_id and c.deleted_at is null   -- удалённый (мягко) чат файлов не отдаёт
          where m.attachment->>'id' = ${id} and not m.deleted)
       or exists (   -- пост публичного канала: превью без подписки (те же условия, что у canRead: @имя, не удалён, не в бане)
         select 1 from messages m join chats c on c.id = m.chat_id and c.kind = 'channel' and c.username is not null and c.deleted_at is null
          where m.attachment->>'id' = ${id} and not m.deleted
            and not exists (select 1 from chat_bans b where b.chat_id = c.id and b.user_id = ${userId}))
       or exists (select 1 from link_previews lp where lp.photo_id = a.id)   -- картинка превью ссылки: публичная страница, видна всем
       or exists (   -- трек в чьём-то профиле: его видят все, кого владелец не заблокировал
         select 1 from profile_music p where p.attachment_id = a.id
            and not exists (select 1 from blocks b where b.owner_id = p.user_id and b.user_id = ${userId}))
       or exists (select 1 from chat_photos cp where cp.big = a.id or cp.small = a.id)   -- фото группы: видно и в приглашении
       or exists (   -- фото профиля: как и сам профиль — всем, кого владелец не заблокировал
         select 1 from user_photos p where (p.big = a.id or p.small = a.id or p.video = a.id)
            and not exists (select 1 from blocks b where b.owner_id = p.user_id and b.user_id = ${userId})))`;
  if (!a) return null;
  // зашифрованный: хранилище отдаёт шифр — тип octet-stream, имя не раскрываем (его знает клиент из сообщения)
  const enc = Number(a.enc) === 1;
  const name = enc ? 'file' : a.name as string;
  if (!variant) return { id, key: (a.storage_key as string | null) ?? id, mime: enc ? 'application/octet-stream' : a.mime as string, name };
  const [v] = await sql`select key, mime from attachment_variants where attachment_id = ${id} and name = ${variant}`;
  return v ? { id, key: v.key as string, mime: enc ? 'application/octet-stream' : v.mime as string, name } : null;
}

/**
 * Подписанный GET с коротким сроком: ссылку не храним нигде (ни в сообщении, ни в IndexedDB) — в данных только id,
 * за ссылкой каждый раз ходят в /files/:id. Тип и Content-Disposition задаёт подпись (response-*), а не то, что лежит
 * в объекте: HTML/SVG и прочее активное отдаётся как octet-stream вложением, даже если клиент положил его с другим типом.
 */
/** Видео и музыка играют дольше ссылки: плеер ходит за кусками (Range) по одному и тому же адресу после редиректа —
 *  на 10-минутной ссылке длинное видео встало бы посередине. Им — 3 часа (но не меньше общего срока: тесты ставят 1 с). */
const STREAM_TTL = 3 * 3600;
export function signedDownload(f: { key: string; mime: string; name: string }, opts: { inline: boolean }): string {
  const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  const ttl = opts.inline && /^(video|audio)\//.test(f.mime) && getTtl >= 60 ? Math.max(getTtl, STREAM_TTL) : getTtl;
  return publicS3().presign(f.key, { method: 'GET', expiresIn: ttl, type: opts.inline ? f.mime : 'application/octet-stream', contentDisposition: disposition });
}

/** pending старше суток — брошенные загрузки: запись и объект (если клиент успел его положить) удаляем. */
export async function sweepPendingUploads(olderThanMs = 24 * 3600_000): Promise<number> {
  const rows = await sql`delete from attachments where status = 'pending' and created_at < now() - ${olderThanMs / 1000} * interval '1 second' returning id, upload_id`;
  for (const r of rows) {
    if (r.upload_id) await abortMultipart(mpInternal(), r.id as string, r.upload_id as string).catch(() => {});
    await s3().delete(r.id as string).catch(() => {});
  }
  // части без записи (запись удалили, а отмена в хранилище не дошла) — тоже, если начаты раньше срока
  const cutoff = Date.now() - olderThanMs;
  const stale = await listMultipart(mpInternal()).catch(() => []);
  for (const u of stale) if (u.initiated.getTime() < cutoff) await abortMultipart(mpInternal(), u.key, u.uploadId).catch(() => {});
  return rows.length;
}
