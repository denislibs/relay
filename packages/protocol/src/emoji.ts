/**
 * Ключ эмодзи для каталогов реакций и группировки плашек. Один и тот же символ клавиатуры приходит
 * по-разному: с селектором U+FE0F («❤️») и без («❤»), с тоном кожи и без. FE0F убираем всегда; тон
 * (U+1F3FB–U+1F3FF) — только если во всей строке он один: у 🧑🏻‍🤝‍🧑🏿 разные тона несут смысл.
 */

const FE0F = /️/gu;
const TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;

export function emojiKey(s: string): string {
  const out = s.replace(FE0F, '');
  const tones = out.match(TONE);
  if (!tones) return out;
  return tones.every((t) => t === tones[0]) ? out.replace(TONE, '') : out;
}

/** Один эмодзи как графема — ровно набор RGI (ZWJ-связки, тона, флаги, keycap); без FE0F («❤») тоже считается. */
const RGI = /^\p{RGI_Emoji}$/v;
const isEmoji = (g: string): boolean => RGI.test(g) || RGI.test(g + '\uFE0F');
const HAS_LETTER = /\p{L}/u;   // буквы в эмодзи не бывают — отказ без разбора на графемы
const EMOJI_ONLY_MAX = 100;
const EMOJI_ONLY_BODY_MAX = 800;
let segmenter: Intl.Segmenter | null = null;

export function emojiOnly(body: string, entities?: readonly { type: string }[] | null): { count: number; keys: string[] } | null {
  if (!body || body.length > EMOJI_ONLY_BODY_MAX || (entities && entities.length) || HAS_LETTER.test(body)) return null;
  const lines = body.split('\n').map((l) => l.replace(/\s+/g, '')).filter((l) => l.length);
  if (!lines.length) return null;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const keys: string[] = [];
  let widest = 0;
  for (const line of lines) {
    let n = 0;
    // по графемам лениво: первая не-эмодзи — отказ без разбора остатка
    for (const { segment } of segmenter.segment(line)) { if (!isEmoji(segment)) return null; keys.push(emojiKey(segment)); n++; }
    if (n > widest) widest = n;
  }
  if (keys.length > EMOJI_ONLY_MAX) return null;
  return { count: Math.max(lines.length, widest), keys };
}
