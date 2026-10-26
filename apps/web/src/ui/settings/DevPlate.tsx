import { Presence } from '@relay/ui';
import { useRef } from 'preact/hooks';
import { getGlobal, setGlobal, useGlobal, type DevSimFlags } from '../../global';
import { go } from '../../nav';
import { setPref } from '../../prefs';

/** Что включено в имитаторе — для плашки. */
export function simText(s: DevSimFlags): string {
  const parts: string[] = [];
  if (s.offline) parts.push('офлайн');
  if (s.profile) parts.push(s.profile.lossPct >= 10 && s.profile.latency >= 1500 ? 'плохая сеть' : 'медленная сеть');
  if (s.dropNextUpdates) parts.push('дыра в журнале');
  if (s.forceTooLong) parts.push('снимок');
  return parts.join(', ');
}

/**
 * Плашка «Режим разработчика: …» над приложением, пока включён любой режим имитатора (во всех вкладках). Клик — вкладка
 * «Сеть». Отдельно от страницы «Для разработчиков» (Dev.tsx): плашка в основном бандле, страница — в чанке настроек.
 */
export function DevPlate() {
  const sim = useGlobal((s) => s.devSim);
  const last = useRef<DevSimFlags | null>(null);
  if (sim) last.current = sim;
  const shown = sim ?? last.current;
  const open = () => {
    setGlobal({ devTab: 'network' });
    if (!getGlobal().prefs.dev.enabled) setPref('dev.enabled', true);
    void go('settings/dev');
  };
  return (
    <Presence show={!!sim} exitMs={200}>
      <button type="button" class="app-devplate" onClick={open} aria-label={'Режим разработчика: ' + (shown ? simText(shown) : '') + '. Открыть настройки сети'}>
        <span class="app-devplate-dot" aria-hidden="true" />
        Режим разработчика: {shown ? simText(shown) : ''}
      </button>
    </Presence>
  );
}
