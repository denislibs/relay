import { CheckRow, PanelHeader, RangeRow, Section } from '@relay/ui';
import { useGlobal } from '../../global';
import { back } from '../../nav';
import { levelOf, setPref } from '../../prefs';
import { useScrollMemory } from '../useScrollMemory';

const NAMES = ['Экономия', 'Быстро и красиво', 'Максимум'];
const MARKS = NAMES.map((label, value) => ({ value, label }));
const systemReduced = (): boolean => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** «Анимации и производительность»: уровень-пресет и отдельные флаги (на этом устройстве). */
export function Performance() {
  const a = useGlobal((s) => s.prefs.anim);
  const bigEmoji = useGlobal((s) => s.prefs.bigEmoji);
  const scroll = useScrollMemory('settings/performance');
  const lv = levelOf(a);
  const reduced = systemReduced();
  const flag = (key: 'ui' | 'wallpaper' | 'blur' | 'autoplayGif' | 'autoplayVideo' | 'autoplayStickers' | 'loopStickers') => (v: boolean) => setPref('anim.' + key, v);
  return (
    <div class="rl-sidepage" aria-label="Анимации и производительность">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Анимации и производительность" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="Уровень анимаций" footer="Чем выше уровень, тем больше анимаций и эффектов.">
          <RangeRow
            label="Уровень" min={0} max={2} step={1} value={a.level} marks={MARKS}
            format={(v: number) => (lv === 'custom' ? 'Своё' : NAMES[v])}
            onChange={(v: number) => { if (v !== a.level || lv === 'custom') setPref('anim.level', v); }}
          />
        </Section>
        {reduced ? <p class="app-perf-note">В системе включено уменьшение движения — анимации интерфейса отключены.</p> : null}
        <Section title="Интерфейс">
          <CheckRow label="Анимации интерфейса" subtitle="Переходы, появление, перестановки, меню" checked={a.ui && !reduced} disabled={reduced} onChange={flag('ui')} />
          <CheckRow label="Анимация обоев" subtitle="Перелив фона при отправке" checked={a.wallpaper} onChange={flag('wallpaper')} />
          <CheckRow label="Размытие" subtitle="Стеклянные панели и меню" checked={a.blur} onChange={flag('blur')} />
        </Section>
        <Section title="Автовоспроизведение">
          <CheckRow label="GIF" checked={a.autoplayGif} onChange={flag('autoplayGif')} />
          <CheckRow label="Видео" checked={a.autoplayVideo} onChange={flag('autoplayVideo')} />
        </Section>
        <Section title="Стикеры">
          <CheckRow label="Анимированные стикеры" subtitle="Играют в чатах и в панели стикеров" checked={a.autoplayStickers} onChange={flag('autoplayStickers')} />
          <CheckRow label="Зацикливать стикеры" subtitle="Иначе стикер в чате проигрывается один раз" checked={a.loopStickers} disabled={!a.autoplayStickers} onChange={flag('loopStickers')} />
        </Section>
        <Section title="Эмодзи">
          <CheckRow label="Крупные эмодзи" subtitle="Сообщение из одних эмодзи — крупно, один эмодзи — анимированный" checked={bigEmoji} onChange={(v: boolean) => setPref('bigEmoji', v)} />
        </Section>
      </div>
    </div>
  );
}
