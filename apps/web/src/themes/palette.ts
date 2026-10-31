// Палитра темы: какие токены и с какими значениями лягут поверх tokens.css для выбранной базы и набора.
// Классическая и Ночь — токены кита как есть (сдвинутые акцентом); День — светлая с залитыми акцентом своими
// пузырями; Тёмная — все поверхности из акцента по формулам iOS (DefaultDarkTintedPresentationTheme).
import tokens from '@relay/ui/tokens.json';
import { accentTokensFor } from '../accent';
import { average, contrast, ensureContrast, flatten, hex, mix, parse, rgb, toHsv, fromHsv, withMul, type Rgb } from './color';
import { BASE_ACCENT, nearestBaseColor, sideOf, type Base, type Side, type ThemeSettings } from './presets';

type TokenDef = { name: string; value: string | { light: string; dark: string } };
const DEFS = tokens.color.tokens as TokenDef[];
/** Значение токена на стороне темы по tokens.json. */
export const tokenValue = (name: string, side: Side): string | undefined => {
  const v = DEFS.find((t) => t.name === name)?.value;
  return typeof v === 'string' ? v : v?.[side];
};

/** Обои базы «как в теме», если ни набор, ни пользователь их не задали (День — светлый голубой, как Day у Telegram). */
const DAY_WALLPAPER = ['#b1e0fa', '#82b0d8', '#a0d8e8', '#e5f0f8'];

export interface PaletteOptions { contrast?: boolean }

/**
 * Токены поверх tokens.css (имя без «--» → значение). Пусто — ровно кит. Кроме токенов кита — переменные для
 * своих пузырей: theme-out-ink (текст), theme-out-meta (время, галочки), theme-out-link (ссылки); relay.css берёт
 * их, если они заданы, иначе считает как раньше.
 */
export function computePalette(base: Base, s: ThemeSettings | null, opts: PaletteOptions = {}): Record<string, string> {
  const side = sideOf(base);
  const out: Record<string, string> = base === 'tinted' ? tinted(s) : base === 'day' ? day(s) : plain(side, s);
  if (opts.contrast) raiseContrast(out, side);
  return out;
}

/** Классическая и Ночь: набор сдвигает фирменные цвета, может задать пузырь и обои. */
function plain(side: Side, s: ThemeSettings | null): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = { ...accentTokensFor(s.accent, side) };
  if (s.bubble?.length) {
    const b = average(s.bubble.map(rgb));
    out['bubble-out'] = hex(b);
    // текст в своём пузыре: в светлой теме пузыри бледные — тёмный акцентный; в тёмной наборы дают яркий пузырь —
    // белый или чёрный, что читается (как tweb: в ночной теме текст исходящих белый)
    if (side === 'dark') setOutInk(out, b);
  }
  if (s.wallpaper) wallpaper(out, s.wallpaper.colors);
  return out;
}

/** День: светлая, холодные белые поверхности; свои пузыри залиты акцентом (или цветом набора), текст в них белый. */
function day(s: ThemeSettings | null): Record<string, string> {
  const accent = s?.accent ?? BASE_ACCENT.day;
  const out: Record<string, string> = {
    ...accentTokensFor(accent, 'light'),
    bg: '#ffffff', panel: '#ffffff', tray: '#ffffff', composer: '#ffffff', field: '#f1f2f5', page: '#f1f2f5',
    'bubble-in': '#f1f1f4', wallpaper: '#ffffff',
  };
  const bubble = s?.bubble?.length ? average(s.bubble.map(rgb)) : rgb(accent);
  out['bubble-out'] = hex(bubble);
  setOutInk(out, bubble);
  wallpaper(out, s?.wallpaper?.colors ?? DAY_WALLPAPER);
  return out;
}

/**
 * Тёмная: акцент (яркость не ниже 0.18, чтобы тёмный акцент не сделал всё чёрным) и от него — каждая поверхность
 * множителями iOS (оттенок, насыщенность, яркость). Свой пузырь — цвет набора или пара iOS «низ/верх» от акцента.
 */
function tinted(s: ThemeSettings | null): Record<string, string> {
  const raw = rgb(s?.accent ?? BASE_ACCENT.tinted);
  const hsv = toHsv(raw);
  const acc = fromHsv([hsv[0], hsv[1], Math.max(hsv[2], 0.18)]);
  const m = (h: number, sat: number, v: number) => withMul(acc, h, sat, v);
  const main = m(1.024, 0.585, 0.25);         // фон списков и карточек
  const additional = m(1.024, 0.573, 0.18);   // фон под ними
  const input = m(1.02, 0.609, 0.15);         // поле ввода (самое тёмное)
  const separator = m(1.033, 0.426, 0.34);
  const secondary = m(1.019, 0.109, 0.59);    // значки, обводки
  const secondaryText = m(0.956, 0.17, 1.0);
  const raised = m(1.024, 0.55, 0.32);        // чуть светлее основного: чужой пузырь, поля — как у Dark Blue
  const out: Record<string, string> = {
    ...accentTokensFor(hex(acc), 'dark'),
    bg: hex(additional), tray: hex(additional), page: hex(input), canvas: hex(input), 'viewer-bg': hex(input),
    panel: hex(main), raised: hex(main), card: hex(main), composer: hex(raised), field: hex(raised),
    glass: `rgba(${main.map(Math.round).join(',')},0.72)`,
    'bubble-in': hex(raised), 'bubble-system': hex(main),
    line: hex(separator), outline: hex(secondary), 'row-icon': hex(secondary), 'avatar-bg': hex(separator),
    'ink-muted': hex(mix(secondaryText, main, 0.62)),
    'accent-soft': hex(mix(acc, main, 0.28)), 'on-accent-soft': '#ffffff',
    wallpaper: hex(additional), 'wallpaper-pattern': hex(input),
  };
  // свой пузырь: цвет набора или iOS «низ = акцент × (1.019, 0.731, 0.59), верх = низ × (0.966, 0.61, 0.98)», усреднённые
  const bottom = withMul(acc, 1.019, 0.731, 0.59);
  const bubble = s?.bubble?.length ? average(s.bubble.map(rgb)) : average([withMul(bottom, 0.966, 0.61, 0.98), bottom]);
  out['bubble-out'] = hex(bubble);
  setOutInk(out, bubble);
  wallpaper(out, s?.wallpaper?.colors ?? nearestBaseColor(hex(raw)).wallpaper);
  return out;
}

/** Текст, время и ссылки в своём пузыре — по контрасту с ним: белые на насыщенном, тёмные на бледном. */
function setOutInk(out: Record<string, string>, bubble: Rgb): void {
  const white: Rgb = [255, 255, 255], ink: Rgb = [10, 10, 10];
  const light = contrast(white, bubble) >= 3 ? white : ink;
  out['theme-out-ink'] = hex(light);
  out['theme-out-meta'] = hex(mix(light, bubble, 0.72));
  out['theme-out-link'] = hex(light);
}

function wallpaper(out: Record<string, string>, colors: string[]): void {
  colors.slice(0, 4).forEach((c, i) => { out['wallpaper-' + (i + 1)] = c; });
}

/**
 * Повышенная контрастность: вторичный текст, акцентный текст, ссылки, «опасное», время в своих пузырях — не меньше
 * 4.9:1 к самой «трудной» поверхности, где они стоят; кнопки — так, чтобы белый текст на них читался.
 */
function raiseContrast(out: Record<string, string>, side: Side): void {
  const val = (name: string) => out[name] ?? tokenValue(name, side) ?? '#000000';
  const solid = (name: string, under: Rgb): Rgb => { const p = parse(val(name)); return p ? flatten(p, under) : under; };
  const bg = solid('bg', side === 'dark' ? [0, 0, 0] : [255, 255, 255]);
  const raised = solid('raised', bg);
  // худшая поверхность из двух: для светлой — более тёмная, для тёмной — более светлая (там контраст меньше)
  const worst = (a: Rgb, b: Rgb) => (contrast(a, [128, 128, 128]) < contrast(b, [128, 128, 128]) ? a : b);
  const surface = worst(bg, raised);
  for (const name of ['ink-muted', 'brand-text', 'danger']) out[name] = hex(ensureContrast(solid(name, surface), surface));
  const bubbleIn = solid('bubble-in', bg), bubbleOut = solid('bubble-out', bg);
  out['tick-read'] = hex(ensureContrast(solid('tick-read', bubbleIn), worst(bubbleIn, bubbleOut)));
  const outInk = parse(out['theme-out-ink'] ?? '') ? rgb(out['theme-out-ink']) : solid('brand-text', bubbleOut);
  const fixedInk = ensureContrast(outInk, bubbleOut);
  out['theme-out-ink'] = hex(fixedInk);
  out['theme-out-meta'] = hex(ensureContrast(mix(fixedInk, bubbleOut, 0.72), bubbleOut));
  out['theme-out-link'] = hex(fixedInk);
  // кнопки и плавающая кнопка: белый текст/значок на них — 4.5 и выше
  for (const name of ['button', 'fab', 'brand-strong']) out[name] = hex(ensureContrast(solid(name, bg), [255, 255, 255], 4.5));
}

/**
 * Свои цвета обоев в «Тёмной»: подмешиваются к тёмному градиенту ближайшего к акценту базового цвета (85% основы),
 * чтобы выбранный цвет не выпадал из тёмной палитры — как в tweb для любых обоев на этой базе.
 */
export function blendForTinted(colors: string[], accent: string): string[] {
  const target = nearestBaseColor(accent).wallpaper;
  return colors.map((c, i) => hex(mix(rgb(target[i % 4]), rgb(c), 0.85).map(Math.round) as Rgb));
}

/** CSS палитр двух сторон — теми же селекторами, что tokens.css: светлая на :root, тёмная по системе и по data-theme. */
export function paletteCss(light: Record<string, string>, dark: Record<string, string>): string {
  // ключ одной стороны не должен протечь в другую: html:root (светлая) действует и в тёмной для того, чего нет в
  // tokens.css (theme-out-*). Недостающее — значением кита, а своё — «initial»: var() тогда берёт запасное значение
  const keys = [...new Set([...Object.keys(light), ...Object.keys(dark)])];
  const block = (p: Record<string, string>, side: Side) => keys.map((k) => `--${k}: ${p[k] ?? tokenValue(k, side) ?? 'initial'};`).join(' ');
  const l = keys.length ? block(light, 'light') : '', d = keys.length ? block(dark, 'dark') : '';
  if (!l && !d) return '';
  // html:root — сильнее :root из tokens.css при любом порядке подключения
  return `html:root { ${l} }\n@media (prefers-color-scheme: dark) { html:root:not([data-theme="light"]) { ${d} } }\nhtml:root[data-theme="dark"] { ${d} }`;
}
