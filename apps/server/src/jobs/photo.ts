import { variantKey } from '@relay/protocol';
import { decryptFile, encryptFile, fileKey } from '../crypto/fileKeys';
// Копии фото в воркере (задача photo.process, ставится при подтверждении загрузки фото и картинки-файла):
//   preview — для сетки «Медиа» и плиток: длинная сторона не больше 480 px, WebP ~80;
//   medium  — для пузыря в ленте: длинная сторона не больше 800 px, WebP ~85 (как средний размер у Telegram);
//             оригинал остаётся для просмотрщика.
// Плитке на 120 px и пузырю на 400 px не нужен оригинал на несколько мегабайт. Маленький и лёгкий оригинал сам себе
// копия; файл, который ffmpeg не разобрал (или слишком большой), помечается skipped — показывается оригинал, как раньше.
// redo — дозаполнение уже обработанных фото (backfillPhotos.ts): делаются только недостающие копии.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '../db';
import { attachmentOf, s3, variantsOf } from '../domain/files';
import { inputOf, patchMessages, probe, run } from './video';
import { enqueue } from './queue';

export const PHOTO_PREVIEW_SIDE = 480;
export const PHOTO_MEDIUM_SIDE = 800;
/** Копии фото: длинная сторона, качество WebP и порог «оригинал и так лёгкий» — не больше side px и легче skipBytes
 *  отдельная копия не нужна. */
const PHOTO_VARIANTS = [
  { name: 'preview', side: PHOTO_PREVIEW_SIDE, quality: 80, skipBytes: 150 * 1024 },
  { name: 'medium', side: PHOTO_MEDIUM_SIDE, quality: 85, skipBytes: 300 * 1024 },
] as const;
export type PhotoVariantName = (typeof PHOTO_VARIANTS)[number]['name'];
/** Тяжелее этого — не трогаем вовсе (показывается оригинал): воркер не качает и не разжимает огромное. */
export const PHOTO_MAX_BYTES = 40 * 1024 * 1024;
/** Больше стольких пикселей не разжимаем: «бомба» — маленький файл, который разворачивается в гигабайты. */
export const PHOTO_MAX_PIXELS = 50_000_000;
/** Картинки, которые браузер показывает и ffmpeg читает, — и демультиплексор для каждой: формат задаётся явно
 *  по заявленному типу (см. inputOf в video.ts). AVIF не трогаем: отдельного демультиплексора у ffmpeg нет. */
const DEMUXER: Record<string, string> = { 'image/jpeg': 'jpeg_pipe', 'image/png': 'png_pipe', 'image/webp': 'webp_pipe', 'image/gif': 'gif' };
/** Предел одного запуска ffmpeg: аренда обычной задачи — 5 минут (queue.ts). */
const FFMPEG_TIMEOUT_MS = 2 * 60_000;

/** Длинная сторона не больше side, без увеличения; вторая — по пропорции. */
const scaleLong = (side: number) => `scale='if(gte(iw,ih),min(${side},iw),-1)':'if(gte(iw,ih),-1,min(${side},ih))'`;

/** Задачу ставить: фото-медиа или картинка, отправленная файлом, известного формата и не больше 40 МБ. */
export const wantsPhotoPreview = (a: { kind?: unknown; mime?: unknown; size?: unknown }) =>
  (a.kind === 'photo' || a.kind === 'file') && String(a.mime) in DEMUXER && Number(a.size) > 0 && Number(a.size) <= PHOTO_MAX_BYTES;

const skip = async (id: string, why: string) => {
  console.warn(`photo: ${id} ${why}, showing the original as is`);
  await sql`update attachments set processed = 'skipped' where id = ${id} and processed is null`;
};

type Made = { name: PhotoVariantName; path: string; w: number; h: number; size: number };

export async function processPhoto(payload: { id: string; redo?: boolean }): Promise<void> {
  const [a] = await sql`select * from attachments where id = ${payload.id}`;
  // redo — только по уже обработанным (done): skipped не разобрался и в прошлый раз, необработанное сделает обычная задача
  if (!a || a.status !== 'ready' || !wantsPhotoPreview(a) || (payload.redo ? a.processed !== 'done' : a.processed)) return;
  const id = a.id as string, key = (a.storage_key as string | null) ?? id, fmt = DEMUXER[a.mime as string];
  const have = new Set(payload.redo ? (await variantsOf(sql, id)).map((v) => v.name as string) : []);
  const todo = PHOTO_VARIANTS.filter((v) => !have.has(v.name));
  if (!todo.length) return;
  const dir = await mkdtemp(join(tmpdir(), 'relay-photo-'));
  try {
    const src = join(dir, 'src');
    // зашифрованный на клиенте: расшифровать во временный файл; копии — шифром ключей, выведенных из ключа файла
    const raw = Number(a.enc) === 1 ? await fileKey(id) : null;
    if (Number(a.enc) === 1 && !raw) return await skip(id, 'has no file key');
    if (raw) { await Bun.write(src + '.enc', s3().file(key)); await decryptFile(src + '.enc', src, raw); await rm(src + '.enc', { force: true }); }
    else await Bun.write(src, s3().file(key));
    // ffprobe читает только заголовок: размеры известны до разжатия
    const p = await probe(src, fmt);
    if (!p) return await skip(id, 'cannot be decoded');
    if (p.w * p.h > PHOTO_MAX_PIXELS) return await skip(id, `is too big (${p.w}x${p.h})`);
    const made: Made[] = [];
    for (const v of todo) {
      if (Math.max(p.w, p.h) <= v.side && Number(a.size) <= v.skipBytes) continue;
      const out = join(dir, `${v.name}.webp`);
      // первый кадр (у gif — он же), без метаданных (EXIF с геопозицией в копию не попадает)
      // max_pixels — предел и у самого декодера (на случай, если заголовок врёт)
      const r = await run(['ffmpeg', '-v', 'error', '-y', '-max_pixels', String(PHOTO_MAX_PIXELS), ...inputOf(src, fmt), '-frames:v', '1', '-an',
        '-vf', scaleLong(v.side), '-c:v', 'libwebp', '-quality', String(v.quality), '-compression_level', '4', '-map_metadata', '-1', out], FFMPEG_TIMEOUT_MS);
      if (r.code !== 0) {
        if (payload.redo || made.length) { console.warn(`photo: ${id} ${v.name} failed: ${r.err}`); continue; }
        return await skip(id, `${v.name} failed: ${r.err}`);
      }
      const size = Bun.file(out).size;
      // копия не легче оригинала — не нужна
      if (size > 0 && size < Number(a.size)) {
        const d = await probe(out, 'webp_pipe');
        if (d) made.push({ name: v.name, path: out, w: d.w, h: d.h, size });
      }
    }
    for (const m of made) {
      if (raw) {
        await encryptFile(m.path, m.path + '.enc', await variantKey(raw, m.name));
        await s3().write(`${id}.${m.name}`, Bun.file(m.path + '.enc'), { type: 'application/octet-stream' });
      } else await s3().write(`${id}.${m.name}`, Bun.file(m.path), { type: 'image/webp' });
    }
    await sql.begin(async (tx) => {
      // под замком строки вложения: отправка того же фото (attachmentForSend, for share) ждёт — как у видео
      const [row] = await tx`select * from attachments where id = ${id} for update`;
      if (!row || (payload.redo ? row.processed !== 'done' : row.processed)) return;
      for (const m of made) {
        await tx`insert into attachment_variants (attachment_id, name, key, mime, size, width, height)
          values (${id}, ${m.name}, ${`${id}.${m.name}`}, 'image/webp', ${m.size}, ${m.w}, ${m.h})
          on conflict (attachment_id, name) do update set key = excluded.key, mime = excluded.mime, size = excluded.size, width = excluded.width, height = excluded.height`;
      }
      const [upd] = payload.redo ? [row] : await tx`update attachments set processed = 'done' where id = ${id} returning *`;
      if (made.length) await patchMessages(tx, attachmentOf(upd, null, await variantsOf(tx, id)));
    });
    const said = made.map((m) => `${m.name} ${m.w}x${m.h} ${Math.round(m.size / 1024)} KB`).join(', ');
    console.log(`photo: ${id} ${p.w}x${p.h} → ${said || 'nothing to do'}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Фото, обработанные до появления копии medium: по задаче photo.process с redo на каждое (dedupe — повторный
 *  запуск не плодит задач). Отбор по заявленным размерам и весу — как порог medium в processPhoto. */
export async function backfillPhotos(opts: { batch?: number; log?: (s: string) => void } = {}): Promise<number> {
  const batch = opts.batch ?? 1000, med = PHOTO_VARIANTS[1];
  let after = '00000000-0000-0000-0000-000000000000', queued = 0;
  for (;;) {
    const rows = await sql`
      select a.id, a.kind, a.mime, a.size from attachments a
       where a.id > ${after}::uuid and a.status = 'ready' and a.processed = 'done'
         and (greatest(coalesce(a.width, 0), coalesce(a.height, 0)) > ${med.side} or a.size > ${med.skipBytes})
         and not exists (select 1 from attachment_variants v where v.attachment_id = a.id and v.name = ${med.name})
       order by a.id limit ${batch}`;
    if (!rows.length) return queued;
    for (const r of rows) {
      if (!wantsPhotoPreview(r)) continue;
      await enqueue(sql, 'photo.process', { id: r.id, redo: true }, { dedupeKey: `photo.redo:${r.id}` });
      queued++;
    }
    after = rows[rows.length - 1].id as string;
    opts.log?.(`photo backfill: queued ${queued}…`);
  }
}
