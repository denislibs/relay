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

/** Один эмодзи как графема: пиктограмма (с модификаторами и ZWJ-связками), keycap (1️⃣) или флаг (пара RI). */
const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|️|‍\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|️)?)*)$/u;
const EMOJI_ONLY_MAX = 100;
const EMOJI_ONLY_BODY_MAX = 800;
let segmenter: Intl.Segmenter | null = null;
const graphemesOf = (s: string): string[] => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(s)].map((x) => x.segment);
};

/**
 * Сообщение из одних эмодзи (как в Telegram): без оформления, текст по строкам целиком из эмодзи (пробелы не в счёт).
 * count — «размер сетки»: максимум из числа строк и эмодзи в самой длинной строке; keys — ключи эмодзи по порядку.
 * Иначе null. Не больше 100 эмодзи и 800 единиц текста.
 */
export function emojiOnly(body: string, entities?: readonly { type: string }[] | null): { count: number; keys: string[] } | null {
  if (!body || body.length > EMOJI_ONLY_BODY_MAX || (entities && entities.length)) return null;
  const lines = body.split('\n').map((l) => l.replace(/\s+/g, '')).filter((l) => l.length);
  if (!lines.length) return null;
  const keys: string[] = [];
  let widest = 0;
  for (const line of lines) {
    const g = graphemesOf(line);
    for (const x of g) { if (!ONE_EMOJI.test(x)) return null; keys.push(emojiKey(x)); }
    if (g.length > widest) widest = g.length;
  }
  if (keys.length > EMOJI_ONLY_MAX) return null;
  return { count: Math.max(lines.length, widest), keys };
}
