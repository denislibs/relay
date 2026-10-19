import { CheckRow, InfoRow, PanelHeader, PATTERN_SETS, buildPattern, loadPattern, patternColor, patternSize, Section } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { setPref } from '../../prefs';
import { back } from '../../nav';
import { COLOR_PRESETS, DEFAULT_PATTERN, PATTERN_NAMES, sameColors, themeWallpaperColors, useWallpaper } from '../../wallpapers';
import { useScrollMemory } from '../useScrollMemory';

const DEFAULT_WP = { pattern: DEFAULT_PATTERN, colors: null, blur: false };

const gradient = (colors: string[] | null): string => {
  const c = colors ?? [1, 2, 3, 4].map((i) => `var(--wallpaper-${i})`);
  return `linear-gradient(135deg, ${c[0]}, ${c[3]} 45%, ${c[1]} 70%, ${c[2]})`;
};

/** Фон превью как у живых обоев: светлая тема — градиент, тёмная — тёмная основа (как у холста). */
export function swatchBackground(colors: string[] | null, dark = false): string {
  return dark ? 'var(--wallpaper-pattern)' : gradient(colors);
}

/** Плитка-превью. Светлая: градиент + узор цветом из фона (patternColor, как у живых обоев). Тёмная: как живой холст — узор залит градиентом поверх тёмной основы. */
export function Swatch({ pattern, colors, dark, size }: { pattern: string; colors: string[] | null; dark: boolean; size?: number }) {
  // плитка в превью — в той же пропорции к живой (420 → 150 px), чтобы узоры читались в своём масштабе
  const tile = Math.round(patternSize(pattern) * 150 / 420);
  return (
    <span class={'app-swatch-fill' + (dark ? ' app-swatch-dark' : '')} style={{ background: swatchBackground(colors, dark), ...(size ? { width: size + 'px', height: size + 'px' } : null) }}>
      <span class="app-swatch-pattern" style={{ '--swatch-pattern': `url(${buildPattern(pattern)})`, '--swatch-tile': tile + 'px', ...(dark ? { background: gradient(colors) } : { background: patternColor(colors ?? themeWallpaperColors(false)), opacity: 1 }) }} />
    </span>
  );
}

export function Wallpaper() {
  const { dark, key, wp } = useWallpaper();
  const scroll = useScrollMemory('settings/general/wallpaper');
  const presets = COLOR_PRESETS[key];
  const isDefault = wp.pattern === DEFAULT_WP.pattern && wp.colors === null && !wp.blur;
  const choose = (pattern: string, colors: string[] | null) => setPref(`wallpaper.${key}`, { ...wp, pattern, colors });
  const sets = Object.keys(PATTERN_SETS);
  const known = sets.includes(wp.pattern) ? wp.pattern : DEFAULT_PATTERN;
  // нарисованные узоры: файлы грузятся один раз; превью показываем, когда загружены все (плитки появляются разом, без мигания по одной)
  const [loaded, setLoaded] = useState(() => sets.every((s) => buildPattern(s).startsWith('"data:')));
  useEffect(() => { if (!loaded) void Promise.allSettled(sets.map((s) => loadPattern(s))).then(() => setLoaded(true)); }, []);

  return (
    <div class="rl-sidepage" aria-label="Обои">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Обои" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Узор" role="radiogroup">
          <div class={'app-swatches app-swatches-patterns' + (loaded ? ' app-swatches-ready' : '')}>
            {sets.map((set) => {
              const on = wp.pattern === set;
              return (
                <button
                  key={set} type="button" role="radio" aria-checked={on} aria-label={'Узор: ' + (PATTERN_NAMES[set] ?? set)} title={PATTERN_NAMES[set] ?? set}
                  class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => choose(set, wp.colors)}
                >
                  <Swatch pattern={set} colors={wp.colors} dark={dark} />
                </button>
              );
            })}
          </div>
        </Section>
        <Section title="Цвет" role="radiogroup">
          <div class="app-swatches">
            {[{ id: 'theme', name: 'Как в теме', colors: null as string[] | null }, ...presets].map((p) => {
              const on = sameColors(wp.colors, p.colors);
              return (
                <button
                  key={p.id} type="button" role="radio" aria-checked={on} aria-label={'Цвет: ' + p.name} title={p.name}
                  class={'app-swatch' + (on ? ' app-swatch-on' : '')} onClick={() => choose(known, p.colors)}
                >
                  <Swatch pattern={known} colors={p.colors} dark={dark} />
                </button>
              );
            })}
          </div>
        </Section>
        <Section footer="Размытие применяется к обоям чата. Обои для светлой и тёмной темы выбираются отдельно.">
          <CheckRow label="Размытие" checked={wp.blur} onChange={(v: boolean) => setPref(`wallpaper.${key}.blur`, v)} />
          <InfoRow icon="history" title="Сбросить" subtitle="Вернуть обои по умолчанию" onClick={() => { if (!isDefault) setPref(`wallpaper.${key}`, DEFAULT_WP); }} />
        </Section>
      </div>
    </div>
  );
}
