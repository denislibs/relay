/**
 * Фото перед отправкой — как в Telegram по умолчанию: длинная сторона не больше 2560 px, JPEG ~0.87.
 * Прозрачные PNG/WebP — в WebP (JPEG залил бы прозрачное чёрным). Ориентация из EXIF применяется при декодировании,
 * сами метаданные (GPS, модель камеры) с перекодированием уходят — тоже как в Telegram.
 * «Отправить как файл» сюда не попадает: там оригинал байт в байт.
 * Не сжимаем: GIF (анимация), уже небольшие JPEG и всё, что после перекодирования не стало меньше.
 */
export const PHOTO_MAX_SIDE = 2560;
const QUALITY = 0.87;
/** JPEG до этого размера и не больше 2560 px — оставляем как есть: выигрыш мал, а качество теряется дважды. */
const SMALL_JPEG = 1024 * 1024;

export interface PhotoResult { file: File; w: number; h: number; compressed: boolean }

export async function compressPhoto(file: File): Promise<PhotoResult | null> {
  if (!/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type)) return null;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return null; }
  try {
    const { width, height } = bmp;
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
    if (k === 1 && file.type === 'image/jpeg' && file.size <= SMALL_JPEG) return { file, w: width, h: height, compressed: false };
    const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
    const alpha = file.type !== 'image/jpeg' && hasAlpha(bmp);
    const type = alpha ? 'image/webp' : 'image/jpeg';
    const out = await encode(bmp, w, h, type, alpha);
    if (!out || out.size >= file.size) return { file, w: width, h: height, compressed: false };
    const name = (file.name || 'photo').replace(/\.[a-z0-9]{2,5}$/i, '') + (alpha ? '.webp' : '.jpg');
    return { file: new File([out], name, { type, lastModified: file.lastModified }), w, h, compressed: true };
  } finally { bmp.close(); }
}

/** Есть ли прозрачность: по уменьшенной копии 64×64 — дёшево и для фото 50 Мп. */
function hasAlpha(bmp: ImageBitmap): boolean {
  const c = canvas(64, 64);
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!g) return false;
  g.drawImage(bmp, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

async function encode(bmp: ImageBitmap, w: number, h: number, type: string, alpha: boolean): Promise<Blob | null> {
  const c = canvas(w, h);
  const g = c.getContext('2d', { alpha }) as CanvasRenderingContext2D | null;
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  if (!alpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(bmp, 0, 0, w, h);
  if ('convertToBlob' in c) return (c as OffscreenCanvas).convertToBlob({ type, quality: QUALITY }).catch(() => null);
  return new Promise((r) => (c as HTMLCanvasElement).toBlob(r, type, QUALITY));
}

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
