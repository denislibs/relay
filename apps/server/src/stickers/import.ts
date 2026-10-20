import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../db';
import { fileHash8, stickersDir } from './files';

/**
 * Паки из ASSETS_DIR/stickers → sticker_sets/stickers. Порядок — _index.json (служебные папки вне его не берём).
 * Идемпотентно: пак переписывается, только если изменился его meta.json или файлы (хэш набора).
 * Анимированные .tgs по формату Telegram всегда 512×512 — не распаковываем; у .webp размер из заголовка.
 */

type Meta = { title: string; short_name?: string; kind: 'sticker' | 'emoji'; cover?: string; stickers: { file: string; emoji: string; path?: string }[] };

/** Размер WebP из заголовка (VP8, VP8L, VP8X); null — не WebP. */
export function webpSize(b: Uint8Array): { w: number; h: number } | null {
  const tag = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 30 || tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WEBP') return null;
  const chunk = tag(12, 4);
  if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}

function dims(path: string, format: string): { w: number; h: number } {
  if (format === 'webp') return webpSize(readFileSync(path)) ?? { w: 512, h: 512 };
  if (format === 'json') {
    try { const j = JSON.parse(readFileSync(path, 'utf8')) as { w?: number; h?: number }; if (j.w && j.h) return { w: j.w, h: j.h }; } catch { /* битый — квадрат */ }
  }
  return { w: 512, h: 512 };
}

const formatOf = (file: string) => (file.match(/\.(tgs|webp|json)$/)?.[1] ?? null) as 'tgs' | 'webp' | 'json' | null;

export async function importStickers(opts: { log?: boolean } = {}): Promise<{ sets: number; changed: number }> {
  const dir = stickersDir();
  let order: string[];
  try { order = (JSON.parse(readFileSync(join(dir, '_index.json'), 'utf8')) as { order: string[] }).order; }
  catch { return { sets: 0, changed: 0 }; }   // ассетов нет (CI, образ без volume) — стикеров нет
  let changed = 0, sets = 0;
  for (const [position, pack] of order.entries()) {
    let meta: Meta, raw: string;
    try { raw = readFileSync(join(dir, pack, 'meta.json'), 'utf8'); meta = JSON.parse(raw) as Meta; } catch { continue; }
    const items: { idx: number; file: string; format: 'tgs' | 'webp' | 'json'; emoji: string; path?: string; hash: string }[] = [];
    for (const [idx, s] of meta.stickers.entries()) {
      const format = formatOf(s.file);
      if (!format) continue;
      const hash = await fileHash8(join(dir, pack, s.file));
      if (hash) items.push({ idx, file: s.file, format, emoji: s.emoji || '🙂', path: s.path, hash });
    }
    if (!items.length) continue;
    sets++;
    let coverFile = meta.cover && formatOf(meta.cover) ? meta.cover : items[0].file;
    let coverHash = await fileHash8(join(dir, pack, coverFile));
    if (!coverHash) { coverFile = items[0].file; coverHash = items[0].hash; }
    // хэш набора: meta.json и файлы — изменилось что-то одно, переимпортируем пак целиком
    const setHash = new Bun.CryptoHasher('sha256').update(raw).update(items.map((i) => i.hash).join(',')).update(String(position)).digest('hex').slice(0, 16);
    const [cur] = await sql`select id, hash from sticker_sets where short_name = ${pack}`;
    if (cur?.hash === setHash) continue;
    changed++;
    await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into sticker_sets (short_name, title, kind, position, count, cover_file, cover_hash, hash)
        values (${pack}, ${meta.title || pack}, ${meta.kind === 'emoji' ? 'emoji' : 'sticker'}, ${position}, ${items.length}, ${coverFile}, ${coverHash}, ${setHash})
        on conflict (short_name) do update set title = excluded.title, kind = excluded.kind, position = excluded.position,
          count = excluded.count, cover_file = excluded.cover_file, cover_hash = excluded.cover_hash, hash = excluded.hash
        returning id`;
      // стикеры с теми же индексами обновляем на месте: id не меняется, недавние и избранные сохраняются
      for (const it of items) {
        const { w, h } = dims(join(dir, pack, it.file), it.format);
        await tx`
          insert into stickers (set_id, idx, file, file_hash, format, emoji, w, h, outline)
          values (${row.id}, ${it.idx}, ${it.file}, ${it.hash}, ${it.format}, ${it.emoji}, ${w}, ${h}, ${it.path ?? null})
          on conflict (set_id, idx) do update set file = excluded.file, file_hash = excluded.file_hash, format = excluded.format,
            emoji = excluded.emoji, w = excluded.w, h = excluded.h, outline = excluded.outline`;
      }
      await tx`delete from stickers where set_id = ${row.id} and idx <> all(${items.map((i) => i.idx)})`;
    });
    if (opts.log) console.log(`stickers: ${pack} (${items.length})`);
  }
  return { sets, changed };
}

/** Есть ли что импортировать (папка смонтирована). */
export function hasStickerAssets(): boolean {
  try { return statSync(join(stickersDir(), '_index.json')).isFile(); } catch { return false; }
}

if (import.meta.main) {
  const t = performance.now();
  const r = await importStickers({ log: true });
  console.log(`stickers: ${r.sets} packs, ${r.changed} changed in ${Math.round(performance.now() - t)} ms`);
  await sql.end();
}

