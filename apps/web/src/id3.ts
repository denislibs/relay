// Теги mp3 (ID3v2.2–2.4): название, исполнитель и обложка — для музыкального пузыря, как в Telegram.
// Читаем только начало файла (теги в ID3v2 идут первыми), без сторонних библиотек.

export interface AudioTags { title: string | null; performer: string | null; cover: { mime: string; data: Uint8Array } | null }

const EMPTY: AudioTags = { title: null, performer: null, cover: null };

function syncsafe(b: Uint8Array, i: number): number { return (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3]; }
function u32(b: Uint8Array, i: number): number { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }

/** Текст в кодировке ID3: 0 — latin1, 1 — UTF-16 с BOM, 2 — UTF-16BE, 3 — UTF-8. Нули на конце убираем. */
function text(enc: number, b: Uint8Array): string {
  let s: string;
  if (enc === 1 || enc === 2) {
    let le = enc === 1, i = 0;
    if (enc === 1 && b.length >= 2) { if (b[0] === 0xff && b[1] === 0xfe) { le = true; i = 2; } else if (b[0] === 0xfe && b[1] === 0xff) { le = false; i = 2; } }
    s = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(b.subarray(i, i + ((b.length - i) & ~1)));
  } else s = new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(b);
  return s.replace(/\u0000+$/, '').replace(/\u0000/g, ' / ').trim();
}

/** Конец строки, заканчивающейся нулём (у UTF-16 — двумя нулями на чётной позиции). */
function zero(b: Uint8Array, from: number, wide: boolean): number {
  if (!wide) { const i = b.indexOf(0, from); return i < 0 ? b.length : i; }
  for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  return b.length;
}

export function parseId3(buf: Uint8Array): AudioTags {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return EMPTY;   // "ID3"
  const ver = buf[3], flags = buf[5];
  const end = Math.min(buf.length, 10 + syncsafe(buf, 6));
  let i = 10;
  if (flags & 0x40 && ver >= 3) i += ver === 4 ? syncsafe(buf, 10) : u32(buf, 10) + 4;   // расширенный заголовок
  const out: AudioTags = { title: null, performer: null, cover: null };
  const v22 = ver === 2, head = v22 ? 6 : 10;
  while (i + head <= end) {
    const id = String.fromCharCode(...buf.subarray(i, i + (v22 ? 3 : 4)));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;   // пошёл паддинг
    const size = v22 ? (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5] : ver === 4 ? syncsafe(buf, i + 4) : u32(buf, i + 4);
    const body = buf.subarray(i + head, Math.min(end, i + head + size));
    i += head + size;
    if (!body.length) continue;
    if ((id === 'TIT2' || id === 'TT2') && !out.title) out.title = text(body[0], body.subarray(1)) || null;
    else if ((id === 'TPE1' || id === 'TP1') && !out.performer) out.performer = text(body[0], body.subarray(1)) || null;
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) {
      const enc = body[0], wide = enc === 1 || enc === 2;
      let p = 1, mime: string;
      if (v22) { const fmt = String.fromCharCode(...body.subarray(1, 4)).toLowerCase(); mime = fmt === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
      else { const z = zero(body, 1, false); mime = new TextDecoder('latin1').decode(body.subarray(1, z)) || 'image/jpeg'; p = z + 1; }
      p += 1;   // тип картинки
      p = zero(body, p, wide) + (wide ? 2 : 1);   // описание
      if (p < body.length) out.cover = { mime: /^image\//.test(mime) ? mime : 'image/' + mime, data: body.subarray(p) };
    }
  }
  return out;
}

/** Теги файла: первые 2 МБ хватает (обложка обычно меньше). Не mp3 / без тегов — пусто. */
export async function readAudioTags(file: Blob): Promise<AudioTags> {
  try { return parseId3(new Uint8Array(await file.slice(0, 2 * 1024 * 1024).arrayBuffer())); } catch { return EMPTY; }
}

/** Обложка → квадрат 96 px JPEG data-URL (не больше 8 КБ — столько сервер принимает в превью). */
export async function coverThumb(cover: { mime: string; data: Uint8Array }): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(new Blob([cover.data], { type: cover.mime }));
    const c = document.createElement('canvas'), S = 96;
    c.width = c.height = S;
    const side = Math.min(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
    bmp.close();
    for (const q of [0.75, 0.6, 0.45]) { const url = c.toDataURL('image/jpeg', q); if (url.length <= 8192) return url; }
    return null;
  } catch { return null; }
}
