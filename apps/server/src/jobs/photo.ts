// Превью фото в воркере (задача photo.process, ставится при подтверждении загрузки фото и картинки-файла):
// уменьшенная копия для сетки «Медиа» и плиток — длинная сторона не больше 480 px, пропорции те же, WebP ~80.
// Плитке на 120 px не нужен оригинал на несколько мегабайт. Маленький и лёгкий оригинал сам себе превью;
// файл, который ffmpeg не разобрал (или слишком большой), помечается skipped — показывается оригинал, как раньше.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '../db';
import { attachmentOf, s3, variantsOf } from '../domain/files';
import { inputOf, patchMessages, probe, run } from './video';

export const PHOTO_PREVIEW_SIDE = 480;
/** Не больше 480 px и легче этого — отдельная копия не нужна: оригинал и так быстро грузится. */
const SKIP_BYTES = 150 * 1024;
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

export async function processPhoto(payload: { id: string }): Promise<void> {
  const [a] = await sql`select * from attachments where id = ${payload.id}`;
  if (!a || a.status !== 'ready' || !wantsPhotoPreview(a) || a.processed) return;
  const id = a.id as string, key = (a.storage_key as string | null) ?? id, fmt = DEMUXER[a.mime as string];
  const dir = await mkdtemp(join(tmpdir(), 'relay-photo-'));
  try {
    const src = join(dir, 'src');
    await Bun.write(src, s3().file(key));
    // ffprobe читает только заголовок: размеры известны до разжатия
    const p = await probe(src, fmt);
    if (!p) return await skip(id, 'cannot be decoded');
    if (p.w * p.h > PHOTO_MAX_PIXELS) return await skip(id, `is too big (${p.w}x${p.h})`);
    let made: { path: string; w: number; h: number; size: number } | null = null;
    if (Math.max(p.w, p.h) > PHOTO_PREVIEW_SIDE || Number(a.size) > SKIP_BYTES) {
      const out = join(dir, 'preview.webp');
      // первый кадр (у gif — он же), без метаданных (EXIF с геопозицией в копию не попадает)
      // max_pixels — предел и у самого декодера (на случай, если заголовок врёт)
      const r = await run(['ffmpeg', '-v', 'error', '-y', '-max_pixels', String(PHOTO_MAX_PIXELS), ...inputOf(src, fmt), '-frames:v', '1', '-an',
        '-vf', scaleLong(PHOTO_PREVIEW_SIDE), '-c:v', 'libwebp', '-quality', '80', '-compression_level', '4', '-map_metadata', '-1', out], FFMPEG_TIMEOUT_MS);
      if (r.code !== 0) return await skip(id, `preview failed: ${r.err}`);
      const size = Bun.file(out).size;
      // копия не легче оригинала — не нужна
      if (size > 0 && size < Number(a.size)) {
        const d = await probe(out, 'webp_pipe');
        if (d) made = { path: out, w: d.w, h: d.h, size };
      }
    }
    if (made) await s3().write(`${id}.preview`, Bun.file(made.path), { type: 'image/webp' });
    await sql.begin(async (tx) => {
      // под замком строки вложения: отправка того же фото (attachmentForSend, for share) ждёт — как у видео
      const [row] = await tx`select * from attachments where id = ${id} for update`;
      if (!row || row.processed) return;
      if (made) {
        await tx`insert into attachment_variants (attachment_id, name, key, mime, size, width, height)
          values (${id}, 'preview', ${`${id}.preview`}, 'image/webp', ${made.size}, ${made.w}, ${made.h})
          on conflict (attachment_id, name) do update set key = excluded.key, mime = excluded.mime, size = excluded.size, width = excluded.width, height = excluded.height`;
      }
      const [upd] = await tx`update attachments set processed = 'done' where id = ${id} returning *`;
      if (made) await patchMessages(tx, attachmentOf(upd, null, await variantsOf(tx, id)));
    });
    console.log(`photo: ${id} ${p.w}x${p.h} → ${made ? `preview ${made.w}x${made.h} ${Math.round(made.size / 1024)} KB` : 'nothing to do'}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
