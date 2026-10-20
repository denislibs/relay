import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Файлы стикеров: /stk/<пак>/<hash8>/<файл>. Публичные и неизменяемые — хэш содержимого в пути,
 * поэтому кэш навсегда; новый файл под тем же именем получит новый адрес. Ассеты лежат вне git и образа
 * (ASSETS_DIR, по умолчанию apps/server/assets рядом с кодом — в dev он смонтирован вместе с ./apps).
 */

const TYPES: Record<string, string> = { tgs: 'application/x-tgsticker', webp: 'image/webp', json: 'application/json' };
const PACK = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^[A-Za-z0-9_-]{1,64}\.(tgs|webp|json)$/;
const HASH = /^[0-9a-f]{8}$/;

export const stickersDir = (): string => join(resolve(process.env.ASSETS_DIR ?? join(import.meta.dir, '..', '..', 'assets')), 'stickers');

// sha256 файла считаем один раз на (путь, размер, время изменения)
const hashes = new Map<string, { size: number; mtime: number; hash: string }>();

export async function fileHash8(path: string): Promise<string | null> {
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = hashes.get(path);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.hash;
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex').slice(0, 8);
  hashes.set(path, { size: st.size, mtime: st.mtimeMs, hash });
  return hash;
}

/** Адрес файла стикера для клиента (тот же хэш, что проверяет serveStickerFile). */
export async function stickerUrl(pack: string, file: string): Promise<string | null> {
  const hash = await fileHash8(join(stickersDir(), pack, file));
  return hash ? `/stk/${pack}/${hash}/${file}` : null;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

export async function serveStickerFile(pathname: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 });
  let parts: string[];
  try { parts = pathname.split('/').slice(2).map(decodeURIComponent); } catch { return new Response('Bad request', { status: 400 }); }
  // закодированные «/», «\» и «..» — попытка выйти из папки пака
  if (parts.some((p) => p.includes('/') || p.includes('\\') || p.includes('..'))) return new Response('Bad request', { status: 400 });
  const [pack, hash, file] = parts;
  if (parts.length !== 3 || !PACK.test(pack) || !HASH.test(hash) || !FILE.test(file)) return notFound();
  const path = join(stickersDir(), pack, file);
  if ((await fileHash8(path)) !== hash) return notFound();
  return new Response(method === 'HEAD' ? null : Bun.file(path), {
    headers: { 'content-type': TYPES[file.slice(file.lastIndexOf('.') + 1)], 'cache-control': 'public, max-age=31536000, immutable' },
  });
}
