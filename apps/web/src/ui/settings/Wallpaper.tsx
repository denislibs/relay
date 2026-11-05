import { CheckRow, ColorPicker, InfoRow, PanelHeader, PATTERN_SETS, RangeRow, buildPattern, intensityAlpha, loadPattern, patternColor, patternSize, Section } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getPrefs, resolveBase, setPref, themeSettings, type WallpaperPref } from '../../prefs';
import { blendForTinted } from '../../themes/palette';
import { BASE_ACCENT } from '../../themes/presets';
import { showToast } from '../../settingsData';
import { deleteImage, saveImage } from '../../wallpaperImage';
import { back, go } from '../../nav';
import { COLOR_PRESETS, DEFAULT_PATTERN, PATTERN_NAMES, sameColors, themeWallpaperColors, useWallpaper } from '../../wallpapers';
import { useScrollMemory } from '../useScrollMemory';

const DEFAULT_WP: WallpaperPref = { pattern: DEFAULT_PATTERN, colors: null, blur: false, intensity: 50, image: null };

const gradient = (colors: string[] | null): string => {
  const c = colors ?? [1, 2, 3, 4].map((i) => `var(--wallpaper-${i})`);
  return `linear-gradient(135deg, ${c[0]}, ${c[3]} 45%, ${c[1]} 70%, ${c[2]})`;
};

/** Фон превью как у живых обоев: светлая тема — градиент, тёмная — тёмная основа (как у холста). */
export function swatchBackground(colors: string[] | null, dark = false): string {
  return dark ? 'var(--wallpaper-pattern)' : gradient(colors);
}

/** Плитка-превью. Светлая: градиент + узор цветом из фона (patternColor, как у живых обоев). Тёмная: как живой холст — узор залит градиентом поверх тёмной основы. */
export function Swatch({ pattern, colors, dark, size, intensity }: { pattern: string; colors: string[] | null; dark: boolean; size?: number; intensity?: number }) {
  // плитка в превью — в той же пропорции к живой (420 → 150 px), чтобы узоры читались в своём масштабе
  const tile = Math.round(patternSize(pattern) * 150 / 420);
  return (
    <span class={'app-swatch-fill' + (dark ? ' app-swatch-dark' : '')} style={{ background: swatchBackground(colors, dark), ...(size ? { width: size + 'px', height: size + 'px' } : null) }}>
      <span class="app-swatch-pattern" style={{ '--swatch-pattern': `url(${buildPattern(pattern)})`, '--swatch-tile': tile + 'px', ...(dark ? { background: gradient(colors), opacity: intensityAlpha(intensity, true) } : { background: patternColor(colors ?? themeWallpaperColors(resolveBase(getPrefs())), intensityAlpha(intensity, false)), opacity: 1 }) }} />
    </span>
  );
}

/** Собственные однотонные цвета (не из Telegram): светлые — пастель, тёмные — глубокие. */
export const SOLID_PRESETS: { light: string[]; dark: string[] } = {
  light: ['#e6ebee', '#cfe0ea', '#a9cbe3', '#cde8d6', '#d9e8b4', '#9fcf98', '#f3e2b8', '#f6d2c0', '#efb59b', '#ecc8d4', '#d6cdea', '#c4c0b4'],
  dark: ['#1d242b', '#13222e', '#0f2a3d', '#16261d', '#232a17', '#1b3324', '#2b2416', '#2e1d18', '#3a2219', '#2c1b25', '#221d33', '#1a1a1d'],
};

/** В «Тёмной» свои цвета подмешиваются к тёмному градиенту акцента (themes/palette.ts blendForTinted). */
const tintedColors = (key: string, colors: string[] | null): string[] | null =>
  key === 'tinted' && colors ? blendForTinted(colors, themeSettings(getPrefs(), 'tinted')?.accent ?? BASE_ACCENT.tinted) : colors;

const solidOf = (wp: WallpaperPref): string | null => (wp.colors && wp.colors.every((c) => c.toLowerCase() === wp.colors![0].toLowerCase()) ? wp.colors[0] : null);

export function Wallpaper() {
  const { dark, key, wp } = useWallpaper();
  const scroll = useScrollMemory('settings/general/wallpaper');
  const presets = COLOR_PRESETS[dark ? 'dark' : 'light'];
  const isDefault = wp.pattern === DEFAULT_WP.pattern && wp.colors === null && !wp.blur && wp.intensity === DEFAULT_WP.intensity && !wp.image;
  // выбрали узор или цвет — своя картинка уступает место обоям
  const choose = (pattern: string, colors: string[] | null) => { setPref(`themes.${key}.wallpaper`, { ...wp, pattern, colors: tintedColors(key, colors), image: null }); if (wp.image) void deleteImage(key); };
  const sets = Object.keys(PATTERN_SETS);
  const known = sets.includes(wp.pattern) ? wp.pattern : DEFAULT_PATTERN;
  const image = !!wp.image;
  // нарисованные узоры: файлы грузятся один раз; превью показываем, когда загружены все (плитки появляются разом, без мигания по одной)
  const [loaded, setLoaded] = useState(() => sets.every((s) => buildPattern(s).startsWith('"data:')));
  useEffect(() => { if (!loaded) void Promise.allSettled(sets.map((s) => loadPattern(s))).then(() => setLoaded(true)); }, []);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { setPref(`themes.${key}.wallpaper`, { ...wp, image: await saveImage(key, f) }); }
    catch { showToast('Не удалось открыть изображение'); }
    finally { setBusy(false); }
  };
  const reset = () => { if (isDefault) return; setPref(`themes.${key}.wallpaper`, DEFAULT_WP); if (wp.image) void deleteImage(key); };
  // ползунок шлёт значение на каждом шаге: живое превью без записи настроек чаще 10 раз в секунду
  const intensity = useThrottledPref(`themes.${key}.wallpaper.intensity`, wp.intensity);
  const solid = solidOf(wp);

  return (
    <div class="rl-sidepage" aria-label="Обои">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Обои" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void upload(f); }} />
          <InfoRow setting="wallpaper.upload" icon="camera" title={busy ? 'Загружаем…' : 'Загрузить изображение'} onClick={() => { if (!busy) file.current?.click(); }} />
          <InfoRow icon="palette" title="Выбрать цвет" subtitle={solid ? solid.toUpperCase() : undefined} onClick={() => void go('settings/general/wallpaper/color')} />
          <InfoRow setting="wallpaper.reset" icon="history" title="Сбросить" subtitle="Вернуть обои по умолчанию" onClick={reset} />
          <CheckRow setting="wallpaper.blur" label="Размытие" checked={image && wp.blur} disabled={!image} onChange={(v: boolean) => setPref(`themes.${key}.wallpaper.blur`, v)} />
          <RangeRow setting="wallpaper.intensity" label="Интенсивность узора" min={0} max={100} step={1} value={intensity.value} disabled={image} onChange={intensity.set} onCommit={intensity.commit} />
        </Section>
        <Section setting="wallpaper.pattern" title="Узор" role="radiogroup">
          <div class={'app-swatches app-swatches-patterns' + (loaded ? ' app-swatches-ready' : '')}>
            {sets.map((set) => {
              const on = !image && wp.pattern === set;
              return (
                <button
                  key={set} type="button" role="radio" aria-checked={on} aria-label={'Узор: ' + (PATTERN_NAMES[set] ?? set)} title={PATTERN_NAMES[set] ?? set}
                  class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => choose(set, wp.colors)}
                >
                  <Swatch pattern={set} colors={wp.colors} dark={dark} intensity={intensity.value} />
                </button>
              );
            })}
          </div>
        </Section>
        <Section setting="wallpaper.colors" title="Цвета и градиенты" role="radiogroup" footer="У каждой темы свои обои. Своё изображение хранится только на этом устройстве.">
          <div class="app-swatches">
            {[{ id: 'theme', name: 'Как в теме', colors: null as string[] | null }, ...presets].map((p) => {
              const on = !image && sameColors(wp.colors, tintedColors(key, p.colors));
              return (
                <button
                  key={p.id} type="button" role="radio" aria-checked={on} aria-label={'Цвет: ' + p.name} title={p.name}
                  class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => choose(known, p.colors)}
                >
                  <Swatch pattern={known} colors={p.colors} dark={dark} intensity={intensity.value} />
                </button>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Значение настройки, которое меняют часто (ползунок, пипетка): на экране — сразу, в настройках — не чаще раза в 100 мс и обязательно последнее. */
function useThrottledPref<T>(path: string, stored: T): { value: T; set: (v: T) => void; commit: (v: T) => void } {
  const [draft, setDraft] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | null>(null);
  const flush = () => { timer.current = null; if (pending.current !== null) { setPref(path, pending.current); pending.current = null; } };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); flush(); } }, [path]);
  // настройка догнала черновик — черновик больше не нужен
  useEffect(() => { if (draft !== null && !timer.current && pending.current === null) setDraft(null); }, [stored]);
  return {
    value: draft ?? stored,
    set: (v) => { setDraft(v); pending.current = v; if (!timer.current) timer.current = setTimeout(flush, 100); },
    commit: (v) => { if (timer.current) clearTimeout(timer.current); pending.current = v; flush(); },
  };
}

/** «Выбрать цвет»: однотонные обои (все четыре цвета градиента одинаковые), узор остаётся. */
export function WallpaperColor() {
  const { dark, key, wp } = useWallpaper();
  const current = solidOf(wp) ?? (wp.colors ?? themeWallpaperColors(key))[0];
  const apply = (c: string) => { setPref(`themes.${key}.wallpaper`, { ...wp, colors: tintedColors(key, [c, c, c, c]), image: null }); if (wp.image) void deleteImage(key); };
  const [shown, setShown] = useState(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(current);
  // пипетку тянут — обои меняются вживую, но настройки пишем не чаще раза в 100 мс (последний цвет — всегда)
  const pick = (c: string) => {
    setShown(c); last.current = c;
    if (!timer.current) timer.current = setTimeout(() => { timer.current = null; apply(last.current); }, 100);
  };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); apply(last.current); } }, []);
  useEffect(() => { if (!timer.current) setShown(current); }, [current]);
  const solid = solidOf(wp);

  return (
    <div class="rl-sidepage" aria-label="Выбрать цвет">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Выбрать цвет" onClose={() => void back()} />
      <div class="rl-settings">
        <Section>
          <ColorPicker value={shown} onChange={pick} label="Цвет обоев" />
        </Section>
        <Section setting="wallpaper.color.presets" title="Готовые цвета" role="radiogroup">
          <div class="app-swatches app-solids">
            {SOLID_PRESETS[dark ? 'dark' : 'light'].map((c) => {
              const on = !!solid && solid.toLowerCase() === c;
              return (
                <button key={c} type="button" role="radio" aria-checked={on} aria-label={'Цвет ' + c.toUpperCase()} title={c.toUpperCase()}
                  class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => { setShown(c); apply(c); }}>
                  <span class="app-swatch-fill" style={{ background: c }} />
                </button>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}
