import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { EmojiGroup, EmojiGroupsCatalog } from '@relay/protocol';
import { emojiDir, fileHash8 } from './files';

/**
 * Группы эмодзи из выгрузки Telegram (ASSETS_DIR/emoji/emoji.json: messages.getEmojiGroups и getEmojiStickerGroups):
 * чипы-категории в поиске панелей эмодзи и стикеров. Иконка — кастом-эмодзи из emoji/documents (/emj/documents/<hash8>/<файл>).
 * Без иконки или без эмодзи (emojiGroupPremium) группа не показывается. Считается лениво, по mtime emoji.json.
 */

interface Raw { _?: string; title?: string; icon_emoji_id?: number | string; emoticons?: string[] }
interface File { groups?: { emoji?: Raw[]; sticker?: Raw[] }; documents?: Record<string, { file?: string }> }

const EMPTY: EmojiGroupsCatalog = { hash: '0', emoji: [], sticker: [] };
const FILE = /^[0-9]{1,24}\.(tgs|webp|json)$/;
// названия приходят по-английски (выгрузка без lang_code) — переводим известные, остальные как есть
const TITLES: Record<string, string> = {
  Love: 'Любовь', Approval: 'Одобрение', Disapproval: 'Неодобрение', Cheers: 'Праздник', Laughter: 'Смех',
  Astonishment: 'Удивление', Sadness: 'Грусть', Anger: 'Злость', Neutral: 'Спокойствие', Doubt: 'Сомнение', Silly: 'Дурачество', Hi: 'Привет',
};

let cache: { stamp: number; value: Promise<EmojiGroupsCatalog> } | null = null;

export function emojiGroupsCatalog(): Promise<EmojiGroupsCatalog> {
  let stamp = 0;
  try { stamp = statSync(join(emojiDir(), 'emoji.json')).mtimeMs; } catch { cache = null; return Promise.resolve(EMPTY); }
  if (cache && cache.stamp === stamp) return cache.value;
  const value = build().catch((e) => { console.warn('emoji groups:', String(e)); cache = null; return EMPTY; });
  cache = { stamp, value };
  return value;
}

async function build(): Promise<EmojiGroupsCatalog> {
  // id документов — 64-битные: числом JSON.parse их округлит и иконка не найдётся, поэтому читаем строкой
  const text = (await Bun.file(join(emojiDir(), 'emoji.json')).text()).replace(/("icon_emoji_id"\s*:\s*)(\d+)/g, '$1"$2"');
  const raw = JSON.parse(text) as File;
  const docs = raw.documents ?? {};
  const groups = async (list: Raw[] | undefined): Promise<EmojiGroup[]> => {
    const out: EmojiGroup[] = [];
    for (const g of list ?? []) {
      const emoticons = (g.emoticons ?? []).filter((e) => typeof e === 'string' && e.length <= 16);
      const file = docs[String(g.icon_emoji_id)]?.file;
      if (!emoticons.length || typeof g.title !== 'string' || typeof file !== 'string' || !FILE.test(file)) continue;
      const hash = await fileHash8(join(emojiDir(), 'documents', file));
      if (hash) out.push({ title: TITLES[g.title] ?? g.title, icon: `/emj/documents/${hash}/${file}`, emoticons });
    }
    return out;
  };
  const emoji = await groups(raw.groups?.emoji), sticker = await groups(raw.groups?.sticker);
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify([emoji, sticker])).digest('hex').slice(0, 16);
  return { hash, emoji, sticker };
}

/** GET /emoji-groups — каталог (нужна сессия); ETag — хэш содержимого, час в кэше клиента. */
export async function emojiGroupsRoute(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || url.pathname !== '/emoji-groups') return null;
  const cat = await emojiGroupsCatalog();
  const etag = `"${cat.hash}"`;
  const headers = { etag, 'cache-control': 'private, max-age=3600' };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return Response.json(cat, { headers });
}
