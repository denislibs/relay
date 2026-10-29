import { requestMutation, setStickerPolicy } from '@relay/ui';
import { ACCENT_IDS, DEFAULT_ACCENT } from './accent';
import { switchAccent, switchTheme } from './themeSwitch';
// Настройки устройства: хранятся в localStorage (`relay.prefs`), применяются в apply() и
// ещё раз — в index.html до первой отрисовки. loadPrefs достраивает недостающее умолчаниями
// и отбрасывает неизвестное.
export type ThemePref = 'system' | 'light' | 'dark';
/** intensity — сила узора 0…100; image — id своей картинки (сама она в IndexedDB этого устройства), null — обои из узора. */
export interface WallpaperPref { pattern: string; colors: string[] | null; blur: boolean; intensity: number; image: string | null }
export interface Prefs {
  v: 1;
  theme: ThemePref;
  accent: string;   // id набора из accent.ts
  textSize: number;
  wallpaper: { light: WallpaperPref; dark: WallpaperPref };
  sendKey: 'enter' | 'ctrlEnter';
  timeFormat: '12h' | '24h' | null;   // null = из локали
  anim: { level: 0 | 1 | 2; ui: boolean; wallpaper: boolean; blur: boolean; autoplayGif: boolean; autoplayVideo: boolean; autoplayStickers: boolean; loopStickers: boolean };
  notify: { web: boolean; sound: boolean; volume: number };
  autoload: {
    enabled: boolean;
    photo: { contacts: boolean; private: boolean; groups: boolean };
    video: { contacts: boolean; private: boolean; groups: boolean };
    file: { contacts: boolean; private: boolean; groups: boolean };
    fileMaxMb: number;
  };
  screen: { blur: boolean; blurDelay: number; hideChatInTitle: boolean; hideUnreadInTitle: boolean; hideNotifyText: boolean };
  media: { keepDays: number; maxMb: number };   // кэш вложений: 0 — без срока / без лимита
  dev: { enabled: boolean };
  bigEmoji: boolean;   // сообщение из одних эмодзи — крупно, один эмодзи — анимированный (как в Telegram)
  folders: { position: 'top' | 'left' };   // вкладки папок: полосой над списком или колонкой слева
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const PREFS_KEY = 'relay.prefs';
const OLD_THEME_KEY = 'relay.theme';

const wp = (): WallpaperPref => ({ pattern: 'cuteMix', colors: null, blur: false, intensity: 50, image: null });
const all = (v: boolean) => ({ contacts: v, private: v, groups: v });
/** @param reduced `prefers-reduced-motion` при первом запуске: уровень анимаций 0. */
export function defaultPrefs(reduced = false): Prefs {
  const on = !reduced;
  return {
    v: 1,
    theme: 'system',
    accent: DEFAULT_ACCENT,
    textSize: 16,
    wallpaper: { light: wp(), dark: wp() },
    sendKey: 'enter',
    timeFormat: null,
    anim: { level: reduced ? 0 : 2, ui: on, wallpaper: on, blur: on, autoplayGif: on, autoplayVideo: on, autoplayStickers: on, loopStickers: on },
    notify: { web: true, sound: true, volume: 0.5 },
    autoload: { enabled: true, photo: all(true), video: all(true), file: all(false), fileMaxMb: 10 },
    screen: { blur: false, blurDelay: 0, hideChatInTitle: false, hideUnreadInTitle: false, hideNotifyText: false },
    media: { keepDays: 30, maxMb: 0 },
    dev: { enabled: false },
    bigEmoji: true,
    folders: { position: 'top' },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Накладывает сохранённое на умолчания: только известные ключи и только того же типа. */
function merge(def: unknown, src: unknown): unknown {
  if (isObj(def)) {
    const s = isObj(src) ? src : {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(def)) out[k] = merge(def[k], Object.prototype.hasOwnProperty.call(s, k) ? s[k] : undefined);
    return out;
  }
  if (def === null) return typeof src === 'string' || typeof src === 'number' ? src : Array.isArray(src) ? src : null; // null-умолчание: любое скалярное/массив
  if (Array.isArray(def)) return Array.isArray(src) ? src : def;
  return typeof src === typeof def ? src : def;
}

const THEMES = ['system', 'light', 'dark'];
const FILE_MB = [1, 5, 10, 50, 100];
const BLUR_DELAY = [0, 5, 30];
export const KEEP_DAYS = [1, 7, 30, 0];
export const CACHE_MB = [500, 1000, 2000, 5000, 0];
const nearest = (steps: number[], v: number): number => steps.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Пресеты флагов для уровня анимаций: 0 экономия, 1 быстро и красиво, 2 максимум. */
export function animPreset(level: 0 | 1 | 2): Prefs['anim'] {
  const on = level !== 0;
  return { level, ui: on, wallpaper: level === 2, blur: level === 2, autoplayGif: on, autoplayVideo: on, autoplayStickers: on, loopStickers: on };
}
/** Уровень по флагам: 'custom', если флаги не совпадают с пресетом уровня («Своё»). */
export function levelOf(a: Prefs['anim']): 0 | 1 | 2 | 'custom' {
  const pr = animPreset(a.level);
  return (['ui', 'wallpaper', 'blur', 'autoplayGif', 'autoplayVideo', 'autoplayStickers', 'loopStickers'] as const).every((k) => a[k] === pr[k]) ? a.level : 'custom';
}

/** Приводит значения к допустимым. Вход не меняет — работает с копией. */
function sanitize(src: Prefs, d: Prefs): Prefs {
  const p = JSON.parse(JSON.stringify(src)) as Prefs;
  p.v = 1;
  if (!THEMES.includes(p.theme)) p.theme = d.theme;
  if (!ACCENT_IDS.includes(p.accent)) p.accent = d.accent;
  if (p.sendKey !== 'enter' && p.sendKey !== 'ctrlEnter') p.sendKey = d.sendKey;
  if (p.folders.position !== 'top' && p.folders.position !== 'left') p.folders.position = d.folders.position;
  if (p.timeFormat !== '12h' && p.timeFormat !== '24h') p.timeFormat = null;
  if (![0, 1, 2].includes(p.anim.level)) p.anim.level = d.anim.level;
  if (typeof p.bigEmoji !== 'boolean') p.bigEmoji = d.bigEmoji;
  p.textSize = Math.min(20, Math.max(12, Math.round(num(p.textSize, d.textSize))));
  p.notify.volume = Math.min(1, Math.max(0, num(p.notify.volume, d.notify.volume)));
  p.autoload.fileMaxMb = nearest(FILE_MB, num(p.autoload.fileMaxMb, d.autoload.fileMaxMb));
  p.screen.blurDelay = nearest(BLUR_DELAY, num(p.screen.blurDelay, 0));
  if (!KEEP_DAYS.includes(p.media.keepDays)) p.media.keepDays = d.media.keepDays;
  if (!CACHE_MB.includes(p.media.maxMb)) p.media.maxMb = d.media.maxMb;
  for (const t of ['light', 'dark'] as const) {
    const w = p.wallpaper[t];
    const c = w.colors as unknown;
    // ровно 4 hex-цвета (в CSS и twallpaper уходят как есть), иначе — цвета темы
    if (c !== null && !(Array.isArray(c) && c.length === 4 && c.every((x) => typeof x === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(x)))) w.colors = null;
    if (typeof w.pattern !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(w.pattern)) w.pattern = d.wallpaper[t].pattern;
    w.blur = w.blur === true;
    w.intensity = Math.min(100, Math.max(0, Math.round(num(w.intensity, 50))));
    if (typeof w.image !== 'string' || !/^[a-z0-9]{1,16}$/.test(w.image)) w.image = null;
  }
  return p;
}

export function loadPrefs(storage: KV | null = defaultStorage(), reduced = false): Prefs {
  const d = defaultPrefs(reduced);
  if (!storage) return d;
  let raw: string | null = null;
  try { raw = storage.getItem(PREFS_KEY); } catch { /* закрытое хранилище */ }
  if (raw !== null) {
    try {
      const j = JSON.parse(raw);
      if (isObj(j) && (j.v === undefined || j.v === 1)) return sharePattern(sanitize(merge(d, j) as Prefs, d)); // без v — до версионирования, это v1
      if (isObj(j) && THEMES.includes(j.theme as string)) d.theme = j.theme as ThemePref; // неизвестная версия: умолчания, тема — если читается
    } catch { /* битый JSON */ }
    return d;
  }
  // первого запуска ещё не было: переносим старую тему
  try { const t = storage.getItem(OLD_THEME_KEY); if (t === 'light' || t === 'dark') d.theme = t; } catch { /* */ }
  return d;
}

/** Узор обоев общий для светлой и тёмной темы. Раньше выбирался отдельно: разошлись — берём узор темы на экране. */
export function sharePattern(p: Prefs, dark?: boolean): Prefs {
  const { light, dark: night } = p.wallpaper;
  if (light.pattern === night.pattern) return p;
  const pattern = ((dark ?? isDark(p.theme)) ? night : light).pattern;
  return { ...p, wallpaper: { light: { ...light, pattern }, dark: { ...night, pattern } } };
}

/** Иммутабельная запись по пути `anim.level`; остальные ветки сохраняют ссылки. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const o = obj as Record<string, unknown>;
  return { ...o, [head]: rest.length ? setPath(o[head] ?? {}, rest.join('.'), value) : value } as T;
}

function defaultStorage(): KV | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
function reducedMotion(): boolean { try { return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }

let storage: KV | null = defaultStorage();
let current: Prefs = loadPrefs(storage, reducedMotion());
let appliedTheme: ThemePref | null = null;
let appliedTime12: boolean | null = null;
let appliedAccent: string | null = null;
const listeners = new Set<(p: Prefs) => void>();

export const getPrefs = (): Prefs => current;
export function subscribePrefs(fn: (p: Prefs) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** Для тестов: подменить хранилище и перечитать. */
export function resetPrefsForTest(kv: KV | null, reduced = false): Prefs { storage = kv; appliedTheme = null; appliedAccent = null; current = loadPrefs(kv, reduced); return current; }

/** Формат времени по умолчанию — из локали браузера (hourCycle h11/h12 = 12 часов). */
let localeFmt: '12h' | '24h' | null = null;   // локаль за сеанс не меняется; без кэша — новый Intl.DateTimeFormat на каждое время в ленте
export function localeTimeFormat(): '12h' | '24h' {
  if (localeFmt) return localeFmt;
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return (localeFmt = hc === 'h11' || hc === 'h12' ? '12h' : '24h');
  } catch { return (localeFmt = '24h'); }
}

export function isDark(pref: ThemePref): boolean {
  return pref === 'dark' || (pref === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Выставляет на :root всё, что зависит от настроек. Тему плавно меняет (themeSwitch.ts), только если она сменилась. */
export function applyPrefs(p: Prefs = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (p.anim.ui) root.removeAttribute('data-anim'); else root.setAttribute('data-anim', '0'); // до темы: смешивание смотрит на data-anim
  if (p.accent !== appliedAccent) { switchAccent(root, p.accent, appliedAccent !== null); appliedAccent = p.accent; }   // до темы: тема смешивает уже акцентные цвета
  if (p.theme !== appliedTheme) { switchTheme(root, p.theme, isDark(p.theme), appliedTheme !== null); appliedTheme = p.theme; }
  root.style.setProperty('--message-text-size', p.textSize + 'px');
  // время в пузыре шире (место под «AM»). При смене — в фазе записи, вместе с рендером ленты (Preact рендерит
  // через requestMutation): иначе кадр пузыри уже шире, а время в них ещё старое — лента прыгает
  const time12 = (p.timeFormat ?? localeTimeFormat()) === '12h';
  if (time12 !== appliedTime12) {
    const set = () => { if (time12) root.setAttribute('data-time12', ''); else root.removeAttribute('data-time12'); };
    if (appliedTime12 === null) set(); else requestMutation(set);
    appliedTime12 = time12;
  }
  if (p.anim.blur) root.removeAttribute('data-blur'); else root.setAttribute('data-blur', '0');
  if (p.anim.wallpaper) root.removeAttribute('data-wpanim'); else root.setAttribute('data-wpanim', '0');
  setStickerPolicy({ autoplay: p.anim.autoplayStickers, loop: p.anim.loopStickers });   // живые стикеры — сразу
}

function commit(next: Prefs, persist: boolean): void {
  current = next;
  if (persist && storage) { try { storage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* приватный режим */ } }
  applyPrefs(next);
  for (const fn of listeners) fn(next);
}

/** Несколько путей одним коммитом: одна запись в хранилище и один проход подписчиков. */
export function setPrefs(values: Record<string, unknown>): void {
  const d = defaultPrefs(reducedMotion());
  let draft: Prefs = current;
  for (const [path, value] of Object.entries(values)) draft = setPath(draft, path, value);
  // узор общий для обеих тем: выбрали в одной — тот же и в другой (цвета у каждой темы свои)
  const patternOf = (t: 'light' | 'dark'): unknown => (draft.wallpaper as Partial<Prefs['wallpaper']> | undefined)?.[t]?.pattern;
  const changed = (['light', 'dark'] as const).find((t) => typeof patternOf(t) === 'string' && patternOf(t) !== current.wallpaper[t].pattern);
  if (changed) draft = setPath(draft, `wallpaper.${changed === 'light' ? 'dark' : 'light'}.pattern`, patternOf(changed));
  let next = sanitize(merge(d, draft) as Prefs, d); // мусор не попадает ни в состояние, ни в хранилище
  if ('anim.level' in values) next = { ...next, anim: animPreset(next.anim.level) };
  commit(next, true);
}
export const setPref = (path: string, value: unknown): void => setPrefs({ [path]: value });

/** Другие вкладки: то же значение подхватываем из события storage. */
export function listenStorage(): void {
  if (typeof addEventListener === 'undefined') return;
  addEventListener('storage', (e: StorageEvent) => {
    let area: Storage | null = null;
    try { area = localStorage; } catch { /* */ }
    if (e.key !== PREFS_KEY || e.storageArea !== area) return;
    commit(loadPrefs(storage, reducedMotion()), false);
  });
}
