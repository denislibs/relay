import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AnimatedEmojiCatalog } from '@relay/protocol';
import { emojiKey } from '@relay/protocol';
import { fileHash8, stickersDir } from '../stickers/files';

/**
 * Каталог анимированных эмодзи: ASSETS_DIR/stickers/animated_emoji (большой эмодзи в одиночном сообщении),
 * emoji_animations (эффект по клику) и emoji_generic_animations (эффект по умолчанию). Папки раздаются как
 * любой пак (/stk/<pack>/<hash8>/<file>), в БД не импортируются. Ключ — emojiKey (без FE0F и тона).
 * Считается лениво, пересчитывается при смене mtime meta.json; без ассетов — пусто.
 */

interface Meta { stickers?: { file?: string; emoji?: string }[] }
const EMPTY: AnimatedEmojiCatalog = { hash: '0', emoji: {}, effects: {}, generic: [] };
const FILE = /^[A-Za-z0-9_-]{1,64}\.(tgs|webp|json)$/;
const PACKS = { emoji: 'animated_emoji', effects: 'emoji_animations', generic: 'emoji_generic_animations' } as const;
// цветные сердца играют эффект красного (как в Telegram)
const HEARTS = ['🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎'];

let cache: { stamp: string; value: Promise<AnimatedEmojiCatalog> } | null = null;

const mtimeOf = (pack: string): number => { try { return statSync(join(stickersDir(), pack, 'meta.json')).mtimeMs; } catch { return 0; } };

export function animatedEmojiCatalog(): Promise<AnimatedEmojiCatalog> {
  const stamp = Object.values(PACKS).map(mtimeOf).join('|');
  if (stamp === '0|0|0') { cache = null; return Promise.resolve(EMPTY); }
  if (cache && cache.stamp === stamp) return cache.value;
  const value = build().catch((e) => { console.warn('animated emoji catalog:', String(e)); cache = null; return EMPTY; });
  cache = { stamp, value };
  return value;
}

async function entries(pack: string): Promise<{ key: string; url: string }[]> {
  let meta: Meta;
  try { meta = (await Bun.file(join(stickersDir(), pack, 'meta.json')).json()) as Meta; } catch { return []; }
  const out: { key: string; url: string }[] = [];
  for (const s of meta.stickers ?? []) {
    if (!s || typeof s.file !== 'string' || typeof s.emoji !== 'string' || !FILE.test(s.file)) continue;
    const hash = await fileHash8(join(stickersDir(), pack, s.file));
    if (hash) out.push({ key: emojiKey(s.emoji), url: `/stk/${pack}/${hash}/${s.file}` });
  }
  return out;
}

async function build(): Promise<AnimatedEmojiCatalog> {
  const emoji: Record<string, string> = {};
  for (const e of await entries(PACKS.emoji)) emoji[e.key] ??= e.url;   // повторы — первый вариант
  const effects: Record<string, string[]> = {};
  for (const e of await entries(PACKS.effects)) (effects[e.key] ??= []).push(e.url);
  if (effects['❤']) for (const h of HEARTS) effects[h] ??= effects['❤'];
  const generic = (await entries(PACKS.generic)).map((e) => e.url);
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify([emoji, effects, generic])).digest('hex').slice(0, 16);
  return { hash, emoji, effects, generic };
}

/** GET /animated-emoji — каталог (нужна сессия); ETag — хэш содержимого, час в кэше клиента. */
export async function animatedEmojiRoute(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || url.pathname !== '/animated-emoji') return null;
  const cat = await animatedEmojiCatalog();
  const etag = `"${cat.hash}"`;
  const headers = { etag, 'cache-control': 'private, max-age=3600' };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return Response.json(cat, { headers });
}
