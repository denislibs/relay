import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AnimatedEmojiCatalog, DiceEmoji, DiceFace } from '@relay/protocol';
import { DICE_FACES, emojiKey } from '@relay/protocol';
import { fileHash8, stickersDir } from '../stickers/files';

/**
 * Каталог анимированных эмодзи: ASSETS_DIR/stickers/animated_emoji (большой эмодзи в одиночном сообщении),
 * emoji_animations (эффект по клику), emoji_generic_animations (эффект по умолчанию) и animated_dice* (грани броска). Папки раздаются как
 * любой пак (/stk/<pack>/<hash8>/<file>), в БД не импортируются. Ключ — emojiKey (без FE0F и тона).
 * Считается лениво, пересчитывается при смене mtime meta.json; без ассетов — пусто.
 */

interface Meta { stickers?: { file?: string; emoji?: string; path?: string }[] }
const EMPTY: AnimatedEmojiCatalog = { hash: '0', emoji: {}, effects: {}, generic: [] };
const FILE = /^[A-Za-z0-9_-]{1,64}\.(tgs|webp|json)$/;
const PACKS = { emoji: 'animated_emoji', effects: 'emoji_animations', generic: 'emoji_generic_animations' } as const;
// наборы бросков (InputStickerSetDice): [0] — «летит», дальше по исходу. 🎰 нет: слоты Telegram собирает из 21 слоя
const DICE: Partial<Record<DiceEmoji, string>> = { '🎲': 'animated_dice', '🎯': 'animated_dice_1f3af', '🏀': 'animated_dice_1f3c0', '⚽': 'animated_dice_26bd', '🎳': 'animated_dice_1f3b3' };
// цветные сердца играют эффект красного (как в Telegram)
const HEARTS = ['🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎'];

let cache: { stamp: string; value: Promise<AnimatedEmojiCatalog> } | null = null;

const mtimeOf = (pack: string): number => { try { return statSync(join(stickersDir(), pack, 'meta.json')).mtimeMs; } catch { return 0; } };

export function animatedEmojiCatalog(): Promise<AnimatedEmojiCatalog> {
  const stamps = [...Object.values(PACKS), ...Object.values(DICE)].map(mtimeOf);
  if (stamps.every((t) => t === 0)) { cache = null; return Promise.resolve(EMPTY); }
  const stamp = stamps.join('|');
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
  const dice: Record<string, DiceFace[]> = {};
  for (const [emoji, pack] of Object.entries(DICE) as [DiceEmoji, string][]) {
    const faces = await diceFaces(pack);
    if (faces.length === DICE_FACES[emoji] + 1) dice[emoji] = faces;   // неполный набор — кубик рисуется своей графикой
  }
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify([emoji, effects, generic, dice])).digest('hex').slice(0, 16);
  return { hash, emoji, effects, generic, dice };
}

/** Грани набора по порядку стикеров (в нём и закодирован исход), с силуэтом — подложка до первого кадра. */
async function diceFaces(pack: string): Promise<DiceFace[]> {
  let meta: Meta;
  try { meta = (await Bun.file(join(stickersDir(), pack, 'meta.json')).json()) as Meta; } catch { return []; }
  const out: DiceFace[] = [];
  for (const s of meta.stickers ?? []) {
    if (!s || typeof s.file !== 'string' || !FILE.test(s.file)) return [];
    const hash = await fileHash8(join(stickersDir(), pack, s.file));
    if (!hash) return [];
    out.push({ url: `/stk/${pack}/${hash}/${s.file}`, outline: typeof s.path === 'string' ? s.path : null });
  }
  return out;
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
