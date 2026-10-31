// Цвета для расчёта тем: разбор, HSV, смешивание, яркость по WCAG и подгонка контраста.
// Формулы — общеизвестные (WCAG 2, HSV) и коэффициенты iOS-клиента Telegram как данные; код свой.

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];
export type Hsv = [number, number, number];   // h 0..360, s 0..1, v 0..1

/** #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() → [r, g, b, a]. */
export function parse(c: string): Rgba | null {
  const s = c.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let x = hex[1];
    if (x.length === 3 || x.length === 4) x = [...x].map((ch) => ch + ch).join('');
    if (x.length !== 6 && x.length !== 8) return null;
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

export const rgb = (c: string): Rgb => { const p = parse(c); if (!p) throw new Error('bad color ' + c); return [p[0], p[1], p[2]]; };
const clamp = (x: number) => Math.round(Math.min(255, Math.max(0, x)));
export const hex = (c: Rgb): string => '#' + c.map((x) => clamp(x).toString(16).padStart(2, '0')).join('');
/** Telegram хранит цвета числом 0xRRGGBB. */
export const fromInt = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

export function toHsv([r, g, b]: Rgb): Hsv {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

export function fromHsv([h, s, v]: Hsv): Rgb {
  const f = (k: number) => { const x = (k + h / 60) % 6; return 255 * (v - v * s * Math.max(0, Math.min(x, 4 - x, 1))); };
  return [f(5), f(3), f(1)];
}

/** iOS UIColor.withMultiplied(hue:saturation:brightness:): каналы HSV умножаются, s и v — не больше 1, оттенок по кругу. */
export function withMul(c: Rgb, h: number, s: number, v: number): Rgb {
  const [ch, cs, cv] = toHsv(c);
  return fromHsv([(ch * h) % 360, Math.min(1, cs * s), Math.min(1, cv * v)]);
}

/** a поверх b с непрозрачностью t (0 — b, 1 — a). */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t)];

/** Полупрозрачный цвет на фоне → сплошной (для контраста и для смешивания). */
export const flatten = (c: Rgba, bg: Rgb): Rgb => mix([c[0], c[1], c[2]], bg, c[3]);

/** Поканальное среднее (так tweb сводит несколько цветов пузыря в один). */
export function average(colors: Rgb[]): Rgb {
  let acc = colors[0];
  for (const c of colors.slice(1)) acc = [(acc[0] + c[0]) / 2, (acc[1] + c[1]) / 2, (acc[2] + c[2]) / 2];
  return [Math.round(acc[0]), Math.round(acc[1]), Math.round(acc[2])];
}

const lin = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
/** Относительная яркость WCAG 2. */
export const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Текст color на фоне bg — не меньше ratio (по умолчанию 4.9, как в tweb: чуть выше AA 4.5). Хватает — как есть.
 * Иначе на светлом фоне цвет темнеет к чёрному (пропорции каналов сохраняются), на тёмном — светлеет к белому;
 * доля подбирается бисекцией — ближайший к исходному цвет, который уже читается.
 */
export function ensureContrast(color: Rgb, bg: Rgb, ratio = 4.9): Rgb {
  if (contrast(color, bg) >= ratio) return color;
  const toward: Rgb = luminance(bg) > 0.179 ? [0, 0, 0] : [255, 255, 255];
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(toward, color, t), bg) >= ratio) hi = t; else lo = t;
  }
  // округление до целых каналов может вернуть чуть ниже порога — дотягиваем мелким шагом
  let t = hi, out = mix(toward, color, t).map((x) => Math.round(x)) as Rgb;
  while (contrast(out, bg) < ratio && t < 1) { t = Math.min(1, t + 0.005); out = mix(toward, color, t).map((x) => Math.round(x)) as Rgb; }
  return out;
}
