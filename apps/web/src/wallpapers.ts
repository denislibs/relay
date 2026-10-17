// Обои чата: наборы цветов приложения (свои, не из Telegram) и хук «какая тема сейчас». Узоры — PATTERN_SETS кита.
import { useEffect, useState } from 'preact/hooks';
import { useGlobal } from './global';
import { isDark, type WallpaperPref } from './prefs';

export interface ColorPreset { id: string; name: string; colors: string[] }

export const COLOR_PRESETS: { light: ColorPreset[]; dark: ColorPreset[] } = {
  light: [
    { id: 'sage', name: 'Шалфей', colors: ['#dfe9d6', '#c9dcc0', '#e8efd9', '#b9d3c5'] },
    { id: 'sky', name: 'Небо', colors: ['#d6e6f5', '#bcd5ef', '#e3eefa', '#a9c8e8'] },
    { id: 'peach', name: 'Персик', colors: ['#f7e1d3', '#f2c9b8', '#fbeee3', '#efb9a6'] },
    { id: 'lilac', name: 'Сирень', colors: ['#e4dcf2', '#d0c4ea', '#efe9f8', '#bfb0e0'] },
    { id: 'sand', name: 'Песок', colors: ['#f1e8d0', '#e6d6ae', '#f7f0dc', '#d9c590'] },
  ],
  dark: [
    { id: 'ink', name: 'Чернила', colors: ['#1b2733', '#16202a', '#22313f', '#101821'] },
    { id: 'plum', name: 'Слива', colors: ['#2a2036', '#1f1829', '#352a45', '#171121'] },
    { id: 'forest', name: 'Хвоя', colors: ['#1a2c25', '#13211c', '#223a31', '#0e1814'] },
    { id: 'ember', name: 'Уголь', colors: ['#33231d', '#261a15', '#40302a', '#1a110d'] },
    { id: 'ocean', name: 'Океан', colors: ['#14283a', '#0f1e2c', '#1b3650', '#0a1621'] },
  ],
};

export const PATTERN_NAMES: Record<string, string> = { catsAndDogs: 'Коты и собаки', doodles: 'Значки' };

export const sameColors = (a: string[] | null, b: string[] | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((c, i) => c === b[i]));

/** Текущая тема с учётом «Как в системе»: считается прямо при рендере (без отставания), ОС-настройка — по подписке. */
export function useIsDark(): boolean {
  const pref = useGlobal((s) => s.prefs.theme);
  const [, tick] = useState(0);
  useEffect(() => {
    if (pref !== 'system' || typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => tick((n) => n + 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [pref]);
  return isDark(pref);
}

/** Обои текущей темы. */
export function useWallpaper(): { dark: boolean; key: 'light' | 'dark'; wp: WallpaperPref } {
  const dark = useIsDark();
  const key = dark ? 'dark' : 'light';
  const wp = useGlobal((s) => s.prefs.wallpaper[key]);
  return { dark, key, wp };
}
