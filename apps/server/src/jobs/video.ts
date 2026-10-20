// Обработка видео-медиа в воркере (задача video.process, ставится при подтверждении загрузки):
//  1) faststart — mp4/mov с moov в конце перепаковывается без перекодирования (moov в начало): браузер начинает
//     играть с первого же куска, без лишнего похода за хвостом файла;
//  2) preview — немой ролик для ленты: первые секунды (короткое — целиком), 360p, H.264, до 1 МБ;
//  3) '720' — H.264 720p для просмотрщика, если оригинал тяжёлый (битрейт выше порога) или не H.264 (HEVC, VP9…).
// До конца обработки всё играет оригинал, как раньше. Файл, который ffprobe не разобрал, помечается skipped.
import type { Attachment, VideoVariant } from '@relay/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '../db';
import { attachmentOf, s3, variantsOf } from '../domain/files';
import { fanOut } from '../domain/journal';
import { enqueue } from './queue';

export const PREVIEW_SECONDS = 4;
/** Короче этого — ролик для ленты из всего видео. */
const PREVIEW_WHOLE_SECONDS = 6;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
const PREVIEW_SIDE = 360;
const SD_SIDE = 720;
/** Выше этого битрейта (бит/с) оригинал тяжёл для просмотра по умолчанию — делается 720p. */
export const SD_BITRATE = 2_500_000;
/** Меньше этого оригинал сам годится для ленты: отдельный ролик не нужен. */
const PREVIEW_SKIP_BYTES = PREVIEW_MAX_BYTES;
/** Старый объект после перепаковки удаляется не сразу: по подписанной ссылке (живёт 3 ч) его ещё могут доигрывать. */
const OLD_OBJECT_GRACE_SEC = 4 * 3600;
/** Предел одного запуска ffmpeg: аренда задачи видео — час (worker.ts), зависший процесс не держит её. */
const FFMPEG_TIMEOUT_MS = 40 * 60_000;

export interface Probe { codec: string; audio: string | null; w: number; h: number; duration: number; bitrate: number }

/** Запуск ffmpeg/ffprobe. Нет программы (образ без ffmpeg) — код 127, а не исключение: файл помечается skipped,
 *  задача не повторяется по кругу. */
export async function run(cmd: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
  const start = () => Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let p: ReturnType<typeof start>;
  try { p = start(); }
  catch (e) { console.warn(`${cmd[0]}: cannot start: ${String(e)}`); return { code: 127, out: '', err: String(e) }; }
  const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err: err.slice(-2000) };
  } finally { clearTimeout(timer); }
}

/**
 * Вход ffmpeg из присланного файла — только локальный файл и только заявленного формата: без -f ffmpeg угадывает
 * формат по содержимому, и «видео», которое на деле плейлист HLS или concat, заставило бы воркер ходить по
 * ссылкам из него (в том числе во внутреннюю сеть) и читать чужие локальные файлы.
 */
export const inputOf = (path: string, format: string | null) =>
  ['-protocol_whitelist', 'file', ...(format ? ['-f', format] : []), '-i', path];
/** Демультиплексор по заявленному типу видео (VIDEO_MIME в domain/files.ts). */
export const videoFormat = (mime: string) => (mime === 'video/webm' ? 'matroska' : 'mov');

/** Первый видеопоток и первый звуковой; null — ffprobe файл не разобрал или видео в нём нет. format — см. inputOf. */
export async function probe(path: string, format: string | null = null): Promise<Probe | null> {
  const r = await run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...inputOf(path, format)], 60_000);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out) as { format?: { duration?: string; bit_rate?: string; size?: string }; streams?: Record<string, unknown>[] };
    const v = j.streams?.find((s) => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
    if (!v || !v.width || !v.height) return null;
    const a = j.streams?.find((s) => s.codec_type === 'audio');
    // повёрнутое (телефон снимал вертикально): ffmpeg при перекодировании поворачивает кадр, стороны меняются местами
    const rot = Math.abs(Number((v.side_data_list as { rotation?: number }[] | undefined)?.find((d) => d.rotation != null)?.rotation ?? (v.tags as { rotate?: string } | undefined)?.rotate ?? 0)) % 180 === 90;
    const duration = Number(j.format?.duration ?? v.duration ?? 0) || 0;
    const size = Number(j.format?.size ?? 0);
    const bitrate = Number(j.format?.bit_rate ?? 0) || (duration > 0 ? (size * 8) / duration : 0);
    return { codec: String(v.codec_name), audio: a ? String(a.codec_name) : null, w: Number(rot ? v.height : v.width), h: Number(rot ? v.width : v.height), duration, bitrate };
  } catch { return null; }
}

/** moov раньше mdat — файл уже faststart (или это не mp4/mov: тогда и перепаковывать нечего). Читаются только заголовки боксов. */
export async function moovFirst(path: string): Promise<boolean> {
  const f = Bun.file(path);
  const size = f.size;
  let pos = 0;
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const head = new DataView(await f.slice(pos, pos + 16).arrayBuffer());
    let len = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (len === 1) len = Number(head.getBigUint64(8));
    else if (len === 0) return true;          // бокс до конца файла — дальше ничего
    if (len < 8) return true;                 // не mp4: не трогаем
    pos += len;
  }
  return true;
}

/** Масштаб «меньшая сторона не больше side» без увеличения; стороны чётные (H.264 4:2:0). */
const scaleTo = (side: number) => `scale='if(gte(iw,ih),-2,min(${side},iw))':'if(gte(iw,ih),min(${side},ih),-2)'`;
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p'];

async function encodePreview(src: string, out: string, p: Probe, fmt: string): Promise<boolean> {
  const t = p.duration > 0 && p.duration <= PREVIEW_WHOLE_SECONDS ? PREVIEW_WHOLE_SECONDS : PREVIEW_SECONDS;
  // первая попытка — по качеству с потолком битрейта; не уложились в 1 МБ — жёстче
  for (const rate of [1600, 700]) {
    const r = await run(['ffmpeg', '-v', 'error', '-y', ...inputOf(src, fmt), '-t', String(t), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', scaleTo(PREVIEW_SIDE), ...H264,
      '-crf', '30', '-maxrate', `${rate}k`, '-bufsize', `${rate * 2}k`, '-movflags', '+faststart', '-map_metadata', '-1', out]);
    if (r.code !== 0) { console.warn(`video: preview failed: ${r.err}`); return false; }
    if (Bun.file(out).size <= PREVIEW_MAX_BYTES) return true;
  }
  return false;
}

async function encodeSd(src: string, out: string, p: Probe, fmt: string): Promise<boolean> {
  const r = await run(['ffmpeg', '-v', 'error', '-y', ...inputOf(src, fmt), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', scaleTo(SD_SIDE), ...H264,
    '-crf', '23', '-maxrate', '3000k', '-bufsize', '6000k', ...(p.audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []), '-movflags', '+faststart', out]);
  if (r.code !== 0) console.warn(`video: 720p failed: ${r.err}`);
  return r.code === 0;
}

async function remuxFaststart(src: string, out: string, fmt: string): Promise<boolean> {
  const r = await run(['ffmpeg', '-v', 'error', '-y', ...inputOf(src, fmt), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', out]);
  if (r.code !== 0) console.warn(`video: faststart remux failed: ${r.err}`);
  return r.code === 0;
}

/** Нужен ли 720p: тяжёлый оригинал крупнее 720p — или кодек, который браузер может не сыграть. */
export const needsSd = (p: Probe) => p.codec !== 'h264' || (p.bitrate > SD_BITRATE && Math.min(p.w, p.h) > SD_SIDE);

export async function processVideo(payload: { id: string }): Promise<void> {
  const [a] = await sql`select * from attachments where id = ${payload.id}`;
  if (!a || a.status !== 'ready' || a.kind !== 'video' || a.processed) return;
  const id = a.id as string, key = (a.storage_key as string | null) ?? id, mime = a.mime as string;
  const dir = await mkdtemp(join(tmpdir(), 'relay-video-'));
  try {
    const ext = mime === 'video/quicktime' ? 'mov' : mime === 'video/webm' ? 'webm' : 'mp4';
    const src = join(dir, `src.${ext}`);
    await Bun.write(src, s3().file(key));
    const fmt = videoFormat(mime);
    const p = await probe(src, fmt);
    if (!p) {
      console.warn(`video: ${id} cannot be decoded, playing the original as is`);
      await sql`update attachments set processed = 'skipped' where id = ${id}`;
      return;
    }
    const made: { name: VideoVariant['name']; key: string; path: string; w: number; h: number }[] = [];
    // 1) faststart: только mp4/mov и только если moov в конце; поток копируется как есть
    let newKey: string | null = null, newSize: number | null = null;
    if (ext !== 'webm' && !(await moovFirst(src))) {
      const fs = join(dir, `fs.${ext}`);
      if (await remuxFaststart(src, fs, fmt)) {
        newKey = `${id}.fs`;
        newSize = Bun.file(fs).size;
        await s3().write(newKey, Bun.file(fs), { type: mime });
      }
    }
    // 2) ролик для ленты; маленький оригинал H.264 сам себе превью
    if (Number(a.size) > PREVIEW_SKIP_BYTES || p.codec !== 'h264') {
      const out = join(dir, 'preview.mp4');
      if (await encodePreview(src, out, p, fmt)) made.push({ name: 'preview', key: `${id}.preview`, path: out, ...(await dims(out)) });
    }
    // 3) 720p для просмотра; вышел не легче оригинала — не нужен
    if (needsSd(p)) {
      const out = join(dir, '720.mp4');
      if (await encodeSd(src, out, p, fmt) && (Bun.file(out).size < Number(a.size) || p.codec !== 'h264')) made.push({ name: '720', key: `${id}.720`, path: out, ...(await dims(out)) });
    }
    for (const v of made) await s3().write(v.key, Bun.file(v.path), { type: 'video/mp4' });
    await sql.begin(async (tx) => {
      // строка вложения под замком: отправка того же видео (attachmentForSend, for share) ждёт — новое сообщение
      // получит копии сразу или окажется в списке ниже, а не между
      const [row] = await tx`select * from attachments where id = ${id} for update`;
      if (!row || row.processed) return;
      for (const v of made) {
        await tx`insert into attachment_variants (attachment_id, name, key, mime, size, width, height)
          values (${id}, ${v.name}, ${v.key}, 'video/mp4', ${Bun.file(v.path).size}, ${v.w}, ${v.h})
          on conflict (attachment_id, name) do update set key = excluded.key, size = excluded.size, width = excluded.width, height = excluded.height`;
      }
      const [upd] = await tx`update attachments set processed = 'done', storage_key = coalesce(${newKey}, storage_key), size = coalesce(${newSize}, size)
        where id = ${id} returning *`;
      if (newKey) await enqueue(tx, 'storage.delete', { key }, { runAt: new Date(Date.now() + OLD_OBJECT_GRACE_SEC * 1000) });
      await patchMessages(tx, attachmentOf(upd, null, await variantsOf(tx, id)));
    });
    console.log(`video: ${id} ${p.codec} ${p.w}x${p.h} ${Math.round(p.bitrate / 1000)} kbit/s → ${[newKey ? 'faststart' : '', ...made.map((v) => v.name)].filter(Boolean).join(', ') || 'nothing to do'}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function dims(path: string): Promise<{ w: number; h: number }> {
  const p = await probe(path, 'mov');
  return p ? { w: p.w, h: p.h } : { w: 0, h: 0 };
}

/** Снимок вложения в сообщениях (и пересланных копиях): размер, копии; миниатюра и спойлер сообщения остаются свои.
 *  Общий для видео и фото (jobs/photo.ts). */
export async function patchMessages(tx: Parameters<Parameters<typeof sql.begin>[0]>[0], fresh: Attachment): Promise<void> {
  const msgs = await tx`select id, chat_id, attachment from messages where attachment->>'id' = ${fresh.id} and not deleted`;
  for (const m of msgs) {
    const old = m.attachment as Attachment;
    const next: Attachment = { ...old, size: fresh.size, ...(fresh.preview ? { preview: fresh.preview } : {}), ...(fresh.variants ? { variants: fresh.variants } : {}) };
    await tx`update messages set attachment = ${tx.json(next as never)} where id = ${m.id} and chat_id = ${m.chat_id}`;
    const members = await tx`select user_id from chat_members where chat_id = ${m.chat_id}`;
    await fanOut(tx, members.map((r) => r.user_id as number), { type: 'attachmentUpdated', chatId: Number(m.chat_id), id: Number(m.id), attachment: next });
  }
}
