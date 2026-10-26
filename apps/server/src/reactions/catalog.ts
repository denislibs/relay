import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactionAsset } from '@relay/protocol';
import { emojiKey } from '@relay/protocol';
import { fileHash8, reactionsDir } from '../stickers/files';

/**
 * Каталог реакций: ASSETS_DIR/reactions/reactions.json (порядок — как у Telegram) плюс файлы по папкам <slug>/.
 * Адреса — /rx/<slug>/<hash8>/<файл>, тот же хэш проверяет serveReactionFile. Считается лениво и один раз,
 * пересчитывается при смене mtime json (файлы меняются только вместе с ним). Без ассетов (CI, тесты) — пусто:
 * клиент рисует реакции глифами.
 */

interface Entry {
  reaction: string; title: string; slug: string; premium?: boolean; inactive?: boolean; silhouette?: string;
  files: { static: string; appear: string; select: string; activate?: string; effect?: string; around?: string; center?: string };
}
export interface ReactionCatalog { hash: string; items: ReactionAsset[] }

const EMPTY: ReactionCatalog = { hash: '0', items: [] };
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;

let cache: { mtime: number; value: Promise<ReactionCatalog> } | null = null;

export function reactionCatalog(): Promise<ReactionCatalog> {
  const file = join(reactionsDir(), 'reactions.json');
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; } catch { cache = null; return Promise.resolve(EMPTY); }
  if (cache && cache.mtime === mtime) return cache.value;
  const value = build(file).catch((e) => { console.warn('reactions catalog:', String(e)); cache = null; return EMPTY; });
  cache = { mtime, value };
  return value;
}

async function build(file: string): Promise<ReactionCatalog> {
  const entries = (await Bun.file(file).json()) as Entry[];
  if (!Array.isArray(entries)) return EMPTY;
  const items: ReactionAsset[] = [];
  for (const e of entries) {
    if (!e || typeof e.reaction !== 'string' || !SLUG.test(e.slug ?? '') || !e.files) continue;
    const dir = join(reactionsDir(), e.slug);
    const url = async (name: string | undefined): Promise<string | null> => {
      if (!name) return null;
      const hash = await fileHash8(join(dir, name));
      return hash ? `/rx/${e.slug}/${hash}/${name}` : null;
    };
    const [st, appear, select, center, around] = await Promise.all([url(e.files.static), url(e.files.appear), url(e.files.select), url(e.files.center), url(e.files.around)]);
    // без обязательных файлов реакцию не отдаём: клиенту нечем её нарисовать
    if (!st || !appear || !select) continue;
    // силуэт — только маленькая PNG data: (её строит tools/reactions/silhouettes.py), иначе не отдаём
    const silhouette = typeof e.silhouette === 'string' && e.silhouette.startsWith('data:image/png;base64,') && e.silhouette.length < 4096 ? e.silhouette : null;
    items.push({ key: emojiKey(e.reaction), title: String(e.title ?? ''), inactive: e.inactive === true, static: st, appear, select, center, around, silhouette });
  }
  // хэш результата: адреса уже содержат хэши файлов, так что любая смена файла или json меняет ETag
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
  return { hash, items };
}
