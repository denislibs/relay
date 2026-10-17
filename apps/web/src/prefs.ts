import { beginHeavyAnimation } from '@relay/ui';
// Настройки устройства: хранятся в localStorage (`relay.prefs`), применяются в apply() и
// ещё раз — в index.html до первой отрисовки. loadPrefs достраивает недостающее умолчаниями
// и отбрасывает неизвестное.
export type ThemePref = 'system' | 'light' | 'dark';
export interface WallpaperPref { pattern: string; colors: string[] | null; blur: boolean }
export interface Prefs {
  theme: ThemePref;
  textSize: number;
  wallpaper: { light: WallpaperPref; dark: WallpaperPref };
  sendKey: 'enter' | 'ctrlEnter';
  timeFormat: '12h' | '24h' | null;   // null = из локали
  anim: { level: 0 | 1 | 2; ui: boolean; wallpaper: boolean; blur: boolean; autoplayGif: boolean; autoplayVideo: boolean };
  notify: { web: boolean; sound: boolean; volume: number };
  autoload: {
    enabled: boolean;
    photo: { contacts: boolean; private: boolean; groups: boolean };
    video: { contacts: boolean; private: boolean; groups: boolean };
    file: { contacts: boolean; private: boolean; groups: boolean };
    fileMaxMb: number;
  };
  screen: { blur: boolean; blurDelay: number; hideChatInTitle: boolean; hideUnreadInTitle: boolean; hideNotifyText: boolean };
  dev: { enabled: boolean };
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const PREFS_KEY = 'relay.prefs';
const OLD_THEME_KEY = 'relay.theme';

const wp = (): WallpaperPref => ({ pattern: 'catsAndDogs', colors: null, blur: false });
const all = (v: boolean) => ({ contacts: v, private: v, groups: v });
/** @param reduced `prefers-reduced-motion` при первом запуске: уровень анимаций 0. */
export function defaultPrefs(reduced = false): Prefs {
  const on = !reduced;
  return {
    theme: 'system',
    textSize: 16,
    wallpaper: { light: wp(), dark: wp() },
    sendKey: 'enter',
    timeFormat: null,
    anim: { level: reduced ? 0 : 2, ui: on, wallpaper: on, blur: on, autoplayGif: on, autoplayVideo: on },
    notify: { web: true, sound: true, volume: 0.5 },
    autoload: { enabled: true, photo: all(true), video: all(true), file: all(false), fileMaxMb: 10 },
    screen: { blur: false, blurDelay: 0, hideChatInTitle: false, hideUnreadInTitle: false, hideNotifyText: false },
    dev: { enabled: false },
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
function sanitize(p: Prefs, d: Prefs): Prefs {
  if (!THEMES.includes(p.theme)) p.theme = d.theme;
  if (p.sendKey !== 'enter' && p.sendKey !== 'ctrlEnter') p.sendKey = d.sendKey;
  if (p.timeFormat !== '12h' && p.timeFormat !== '24h') p.timeFormat = null;
  if (![0, 1, 2].includes(p.anim.level)) p.anim.level = d.anim.level;
  if (!(p.textSize >= 10 && p.textSize <= 40)) p.textSize = d.textSize;
  for (const t of ['light', 'dark'] as const) {
    const c = p.wallpaper[t].colors as unknown;
    if (c !== null && !(Array.isArray(c) && c.every((x) => typeof x === 'string'))) p.wallpaper[t].colors = null;
  }
  return p;
}

export function loadPrefs(storage: KV | null = defaultStorage(), reduced = false): Prefs {
  const d = defaultPrefs(reduced);
  if (!storage) return d;
  let raw: string | null = null;
  try { raw = storage.getItem(PREFS_KEY); } catch { /* закрытое хранилище */ }
  if (raw !== null) {
    try { return sanitize(merge(d, JSON.parse(raw)) as Prefs, d); } catch { return d; }
  }
  // первого запуска ещё не было: переносим старую тему
  try { const t = storage.getItem(OLD_THEME_KEY); if (t === 'light' || t === 'dark') d.theme = t; } catch { /* */ }
  return d;
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
const listeners = new Set<(p: Prefs) => void>();

export const getPrefs = (): Prefs => current;
export function subscribePrefs(fn: (p: Prefs) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** Для тестов: подменить хранилище и перечитать. */
export function resetPrefsForTest(kv: KV | null, reduced = false): Prefs { storage = kv; appliedTheme = null; current = loadPrefs(kv, reduced); return current; }

export function isDark(pref: ThemePref): boolean {
  return pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(root: HTMLElement, pref: ThemePref, animate: boolean): void {
  if (animate) { // цвета всей страницы переливаются — тяжёлая анимация
    const end = beginHeavyAnimation(450);
    root.classList.add('rl-theme-anim');
    setTimeout(() => { root.classList.remove('rl-theme-anim'); end(); }, 450);
  }
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref);
}

/** Выставляет на :root всё, что зависит от настроек. Тему плавно меняет, только если она сменилась. */
export function applyPrefs(p: Prefs = current): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (p.theme !== appliedTheme) { applyTheme(root, p.theme, appliedTheme !== null); appliedTheme = p.theme; }
  root.style.setProperty('--message-text-size', p.textSize + 'px');
  if (p.anim.ui) root.removeAttribute('data-anim'); else root.setAttribute('data-anim', '0');
  if (p.anim.blur) root.removeAttribute('data-blur'); else root.setAttribute('data-blur', '0');
}

function commit(next: Prefs, persist: boolean): void {
  current = next;
  if (persist && storage) { try { storage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* приватный режим */ } }
  applyPrefs(next);
  for (const fn of listeners) fn(next);
}

export function setPref(path: string, value: unknown): void {
  commit(sanitize(setPath(current, path, value), defaultPrefs()), true);
}

/** Другие вкладки: то же значение подхватываем из события storage. */
export function listenStorage(): void {
  if (typeof addEventListener === 'undefined') return;
  addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== PREFS_KEY && e.key !== null) return;
    commit(loadPrefs(storage, reducedMotion()), false);
  });
}
