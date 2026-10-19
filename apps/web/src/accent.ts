import tokens from '@relay/ui/tokens.json';
// Акцентный цвет приложения. Пользователь выбирает один цвет; от разницы между базовым акцентом
// (--brand) и выбранным сдвигаются оттенок, насыщенность и яркость «фирменных» токенов: кнопки,
// ссылки, свои пузыри, обои по умолчанию. Цвета дальше 30° по оттенку от базового не трогаются,
// а яркость не уходит «не в ту сторону»: в светлой теме цвет не светлеет, в тёмной — не темнеет.

export interface AccentPreset { id: string; name: string; color: string }

/** Наборы приложения. Первый — без сдвига (цвета кита как есть). */
export const ACCENTS: AccentPreset[] = [
  { id: 'green', name: 'Зелёный', color: '#25d366' },
  { id: 'blue', name: 'Синий', color: '#3a8ee6' },
  { id: 'violet', name: 'Фиолетовый', color: '#8b6cf0' },
  { id: 'cyan', name: 'Бирюзовый', color: '#1fb5c9' },
  { id: 'orange', name: 'Оранжевый', color: '#f08a2c' },
  { id: 'pink', name: 'Розовый', color: '#e65c94' },
  { id: 'red', name: 'Красный', color: '#e5534b' },
];
export const ACCENT_IDS = ACCENTS.map((a) => a.id);
export const DEFAULT_ACCENT = 'green';

// «Фирменные» токены. Цвета собеседников, зелёные плитки настроек и «успех» — не акцент, их нет в списке.
const ACCENT_TOKENS = ['brand', 'brand-strong', 'brand-text', 'on-accent-soft', 'voice-new', 'fab', 'button', 'button-hover'];
// Подложки и обои: бледные и разнооттеночные (обои — градиент от жёлто-зелёного до бирюзового), правило 30° их
// бы пропустило. Их оттенок поворачивается целиком на ту же разницу, яркость сохраняется.
const TINT_TOKENS = ['accent-soft', 'bubble-out', 'wallpaper-1', 'wallpaper-2', 'wallpaper-3', 'wallpaper-4', 'wallpaper-pattern'];

type Rgb = [number, number, number];
type Hsv = [number, number, number];   // h 0..360, s 0..1, v 0..1

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c: Rgb): string => '#' + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');

function rgbToHsv([r, g, b]: Rgb): Hsv {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb([h, s, v]: Hsv): Rgb {
  const f = (k: number) => { const x = (k + h / 60) % 6; return 255 * (v - v * s * Math.max(0, Math.min(x, 4 - x, 1))); };
  return [f(5), f(3), f(1)];
}
const brightness = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Сдвиг одного цвета: base — базовый акцент темы, accent — выбранный. null — цвет не акцентный, не трогаем. */
export function shiftColor(color: Rgb, base: Hsv, accent: Hsv, dark: boolean): Rgb | null {
  const c = rgbToHsv(color);
  if (hueDist(c[0], base[0]) > 30) return null;
  return adjust(color, c, base, accent, dark);
}

/** Подложка: оттенок — к акценту (со сжатым отступом), насыщенность — в той же пропорции, яркость не трогаем. */
export function tintColor(color: Rgb, base: Hsv, accent: Hsv, dark: boolean): Rgb {
  const c = rgbToHsv(color);
  // отступ от базового оттенка сжимаем: у зелёного пузыря он −31°, и при простом повороте
  // синий акцент дал бы бирюзовый пузырь, оранжевый — розовый. Градиент обоев сохраняет переливы, но уже
  const off = ((c[0] - base[0] + 540) % 360) - 180;
  const h = (accent[0] + off * 0.35 + 360) % 360;
  const s = base[1] ? Math.min(1, c[1] * accent[1] / base[1]) : c[1];
  return keepBrightness(color, h, s, c[2], dark);
}

function adjust(color: Rgb, c: Hsv, base: Hsv, accent: Hsv, dark: boolean): Rgb {
  // насколько цвет «акцентный»: бледные (фон пузыря, обои) насыщенность получают пропорционально, без перекраски яркости
  const dist = base[1] ? Math.min(1.5 * c[1] / base[1], 1) : 0;
  const h = (c[0] + accent[0] - base[0] + 360) % 360;
  const s = base[1] ? Math.min(1, c[1] * accent[1] / base[1]) : c[1];
  const v = base[2] ? Math.min(1, c[2] * (1 - dist + dist * accent[2] / base[2])) : c[2];
  return keepBrightness(color, h, s, v, dark);
}

function keepBrightness(color: Rgb, h: number, s: number, v: number, dark: boolean): Rgb {
  let out = hsvToRgb([h, s, v]);
  const was = brightness(color);
  // светлая тема: цвет не должен стать светлее (текст и кнопки теряют контраст); тёмная — темнее
  if (dark ? brightness(out) < was : brightness(out) > was) {
    for (let i = 0; i < 24; i++) {        // подбираем яркость, при которой воспринимаемая светлота как была
      v = Math.min(1, Math.max(0, v * (was / Math.max(brightness(out), 1e-4))));
      out = hsvToRgb([h, s, v]);
      if (Math.abs(brightness(out) - was) < 0.002) break;
    }
  }
  return out;
}

const rel = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * rel(r) + 0.7152 * rel(g) + 0.0722 * rel(b);
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

type TokenDef = { name: string; value: string | { light: string; dark: string } };
const ALL = tokens.color.tokens as TokenDef[];
const valueOf = (name: string, theme: 'light' | 'dark') => { const v = ALL.find((t) => t.name === name)?.value; return typeof v === 'string' ? v : v?.[theme]; };

/** Значения токенов для акцента в теме: только то, что меняется. Для набора по умолчанию — пусто. */
export function accentTokens(id: string, theme: 'light' | 'dark'): Record<string, string> {
  const preset = ACCENTS.find((a) => a.id === id);
  if (!preset || id === DEFAULT_ACCENT) return {};
  const baseRgb = hexToRgb(valueOf('brand', theme) ?? ''), accRgb = hexToRgb(preset.color);
  if (!baseRgb || !accRgb) return {};
  const base = rgbToHsv(baseRgb), acc = rgbToHsv(accRgb);
  const out: Record<string, string> = {};
  for (const name of ACCENT_TOKENS) {
    const rgb = hexToRgb(valueOf(name, theme) ?? '');
    const shifted = rgb && shiftColor(rgb, base, acc, theme === 'dark');
    if (shifted) out[name] = rgbToHex(shifted);
  }
  for (const name of TINT_TOKENS) {
    const rgb = hexToRgb(valueOf(name, theme) ?? '');
    if (rgb) out[name] = rgbToHex(tintColor(rgb, base, acc, theme === 'dark'));
  }
  // текст на акцентной кнопке: белый, если читается (контраст ≥ 3 — крупный текст и значки), иначе тёмный
  const brand = hexToRgb(out.brand ?? valueOf('brand', theme) ?? '');
  if (brand) out['on-brand'] = contrast(brand, [255, 255, 255]) >= 3 ? '#ffffff' : '#0a0a0a';
  return out;
}

/** CSS для акцента в обеих темах — теми же селекторами, что tokens.css. Пусто для набора по умолчанию. */
export function accentCss(id: string): string {
  const block = (theme: 'light' | 'dark') => Object.entries(accentTokens(id, theme)).map(([k, v]) => `--${k}: ${v};`).join(' ');
  const light = block('light'), dark = block('dark');
  if (!light && !dark) return '';
  // html:root — сильнее :root из tokens.css при любом порядке подключения (index.html ставит стиль раньше ссылок)
  return `html:root { ${light} }\n@media (prefers-color-scheme: dark) { html:root:not([data-theme="light"]) { ${dark} } }\nhtml:root[data-theme="dark"] { ${dark} }`;
}
