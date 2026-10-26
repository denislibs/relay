// Таблица эмодзи для панели из emoji-datasource (MIT, https://github.com/iamcal/emoji-data):
// категории в порядке Telegram, варианты оттенка кожи, английские имена для поиска.
// Берутся только эмодзи, для которых есть картинка в public/emoji/apple.
//   npm pack emoji-datasource@16.0.0 && tar -xzf emoji-datasource-16.0.0.tgz
//   bun apps/web/scripts/genEmoji.ts package/emoji.json
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface Row {
  unified: string; name: string; short_names: string[]; category: string; sort_order: number; has_img_apple: boolean; obsoleted_by?: string;
  skin_variations?: Record<string, { unified: string; has_img_apple: boolean }>;
}

const src = process.argv[2];
if (!src) throw new Error('usage: bun apps/web/scripts/genEmoji.ts <emoji.json>');
const VERSION = '16.0.0';
const root = join(import.meta.dir, '..');
const imgDir = join(root, 'public', 'emoji', 'apple');
const out = join(root, 'src', 'ui', 'stickers', 'emojiTable.ts');

const CATS: Record<string, string> = {
  'Smileys & Emotion': 'people', 'People & Body': 'people', 'Animals & Nature': 'nature', 'Food & Drink': 'food',
  Activities: 'activity', 'Travel & Places': 'travel', Objects: 'objects', Symbols: 'symbols', Flags: 'flags',
};
const ORDER = ['people', 'nature', 'food', 'activity', 'travel', 'objects', 'symbols', 'flags'];
const TONES = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];

const str = (unified: string) => String.fromCodePoint(...unified.split('-').map((h) => parseInt(h, 16)));
const file = (unified: string) => unified.toLowerCase().split('-').filter((h) => h !== 'fe0f').join('-') + '.png';
const hasImg = (unified: string) => existsSync(join(imgDir, file(unified)));

const rows = (await Bun.file(src).json() as Row[])
  .filter((r) => CATS[r.category] && r.has_img_apple && !r.obsoleted_by && hasImg(r.unified))
  .sort((a, b) => a.sort_order - b.sort_order);

const lists: Record<string, string[]> = Object.fromEntries(ORDER.map((c) => [c, []]));
const tones: Record<string, string[]> = {};
const names: Record<string, string> = {};
for (const r of rows) {
  const e = str(r.unified);
  lists[CATS[r.category]].push(e);
  names[e] = [...new Set([...(r.name ?? '').toLowerCase().split(/[^a-z0-9]+/), ...r.short_names.join(' ').replace(/_/g, ' ').split(' ')])].filter(Boolean).join(' ');
  const sv = r.skin_variations;
  if (!sv) continue;
  // один оттенок на всё эмодзи: «1F3FB» или, у пар, «1F3FB-1F3FB»
  const v = TONES.map((t) => sv[t] ?? sv[t + '-' + t]);
  if (v.every((x) => x && x.has_img_apple && hasImg(x.unified))) tones[e] = v.map((x) => str(x!.unified));
}

const body = `// СГЕНЕРИРОВАНО apps/web/scripts/genEmoji.ts из emoji-datasource@${VERSION} (MIT) — не править руками.
// Эмодзи по категориям (порядок Unicode), пять оттенков кожи для эмодзи, у которых они есть, английские имена.
export const EMOJI_LISTS: Record<string, string[]> = ${JSON.stringify(lists)};
export const EMOJI_TONES: Record<string, string[]> = ${JSON.stringify(tones)};
export const EMOJI_NAMES: Record<string, string> = ${JSON.stringify(names)};
`;
await Bun.write(out, body);
console.log(`emoji: ${rows.length}, with tones: ${Object.keys(tones).length} → ${out} (${(body.length / 1024).toFixed(0)} KB)`);
