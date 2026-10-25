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
