import { Bubble, InfoRow, PanelHeader, RadioRow, RangeRow, Section } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { useGlobal } from '../../global';
import { back, go } from '../../nav';
import { ACCENTS } from '../../accent';
import { setPref, type ThemePref } from '../../prefs';
import { useWallpaper } from '../../wallpapers';
import { useWallpaperImage } from '../../wallpaperImage';
import { hm, localeTimeFormat } from '../format';
import { useScrollMemory } from '../useScrollMemory';
import { Swatch, swatchBackground } from './Wallpaper';

const THEMES: { pref: ThemePref; title: string }[] = [
  { pref: 'system', title: 'Как в системе' },
  { pref: 'light', title: 'Светлая' },
  { pref: 'dark', title: 'Тёмная' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Текущее время, обновляется на границе минуты. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => { setNow(new Date()); t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50); };
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(t);
  }, []);
  return now;
}

export function General() {
  const prefs = useGlobal((s) => s.prefs);
  const { dark, wp, key } = useWallpaper();
  const wpImage = useWallpaperImage(key, wp.image);
  const scroll = useScrollMemory('settings/general');
  const now = useNow();
  const fmt = prefs.timeFormat ?? localeTimeFormat();

  return (
    <div class="rl-sidepage" aria-label="Общие настройки">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Общие настройки" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Настройки">
          <div class="app-textpreview" style={wpImage ? { background: `center / cover no-repeat url("${wpImage}")` } : { background: swatchBackground(wp.colors, dark) }} aria-hidden="true">
            <Bubble from="in" tail time={hm(now)}>Привет! Так выглядит ваш текст.</Bubble>
            <Bubble from="out" tail time={hm(now)} status="read">Отлично, размер подходит.</Bubble>
          </div>
          <RangeRow setting="general.textSize" label="Размер текста сообщений" min={12} max={20} step={1} value={prefs.textSize} onChange={(v: number) => setPref('textSize', v)} />
          <InfoRow
            icon="image" title="Обои чата" onClick={() => void go('settings/general/wallpaper')}
            trailing={<span class="app-swatch-mini" aria-hidden="true">{wpImage ? <span class="app-swatch-fill app-swatch-photo" style={{ backgroundImage: `url("${wpImage}")` }} /> : <Swatch pattern={wp.pattern} colors={wp.colors} dark={dark} intensity={wp.intensity} />}</span>}
          />
        </Section>
        <Section setting="general.theme" title="Тема" role="radiogroup">
          {THEMES.map((t) => <RadioRow setting={'general.theme.' + t.pref} key={t.pref} label={t.title} checked={prefs.theme === t.pref} onClick={() => setPref('theme', t.pref)} />)}
        </Section>
        <Section setting="general.accent" title="Цвет акцента" role="radiogroup">
          <div class="app-accents">
            {ACCENTS.map((a) => (
              <button
                key={a.id} type="button" role="radio" class="app-accent" aria-checked={prefs.accent === a.id ? 'true' : 'false'}
                aria-label={a.name} title={a.name} style={{ '--swatch': a.color }}
                onClick={() => setPref('accent', a.id)}
              />
            ))}
          </div>
        </Section>
        <Section setting="general.timeFormat" title="Формат времени" role="radiogroup">
          <RadioRow setting="general.timeFormat.12h" label="12 часов" subtitle={hm(now, '12h')} checked={fmt === '12h'} onClick={() => setPref('timeFormat', '12h')} />
          <RadioRow setting="general.timeFormat.24h" label="24 часа" subtitle={hm(now, '24h')} checked={fmt === '24h'} onClick={() => setPref('timeFormat', '24h')} />
        </Section>
        <Section setting="general.sendKey" title="Клавиатура" role="radiogroup">
          <RadioRow setting="general.sendKey.enter" label="Enter — отправить, Shift+Enter — новая строка" checked={prefs.sendKey === 'enter'} onClick={() => setPref('sendKey', 'enter')} />
          <RadioRow setting="general.sendKey.ctrlEnter"
            label={isMac ? '⌘+Enter — отправить' : 'Ctrl+Enter — отправить'} subtitle="Enter — новая строка"
            checked={prefs.sendKey === 'ctrlEnter'} onClick={() => setPref('sendKey', 'ctrlEnter')}
          />
        </Section>
        <Section>
          <InfoRow icon="keyboard" title="Сочетания клавиш" onClick={() => void go('settings/general/shortcuts')} />
        </Section>
      </div>
    </div>
  );
}
