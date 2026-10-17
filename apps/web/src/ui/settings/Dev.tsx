import { FolderTabs, PanelHeader, Presence, SlideStack } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { markErrorsSeen, newErrorCount, subscribeErrors } from '../../devtools/metrics';
import { openDevSession, setServerPolling } from '../../devtools/session';
import { getGlobal, setGlobal, useGlobal, type DevSimFlags, type DevTab } from '../../global';
import { back, go } from '../../nav';
import { setPref } from '../../prefs';
import { DevData } from './DevData';
import { DevErrors } from './DevErrors';
import { DevLog } from './DevLog';
import { DevNetwork } from './DevNetwork';
import { DevOverview } from './DevOverview';

const TABS: DevTab[] = ['overview', 'log', 'network', 'data', 'errors'];
const LABELS: Record<DevTab, string> = { overview: 'Обзор', log: 'Журнал', network: 'Сеть', data: 'Данные', errors: 'Ошибки' };

/** Счётчик новых ошибок для вкладки (и сброс, пока вкладка открыта). */
function useNewErrors(active: boolean): number {
  const [n, setN] = useState(newErrorCount());
  useEffect(() => subscribeErrors(() => { if (active) markErrorsSeen(); setN(newErrorCount()); }), [active]);
  useEffect(() => { if (active) markErrorsSeen(); setN(newErrorCount()); }, [active]);
  return n;
}

/** «Для разработчиков» (скрытый раздел): вкладки Обзор / Журнал / Сеть / Данные / Ошибки. Данные живут, только пока страница открыта. */
export function Dev() {
  const tab = useGlobal((s) => s.devTab);
  const errs = useNewErrors(tab === 'errors');

  useEffect(() => {
    return openDevSession();
  }, []);
  useEffect(() => { setServerPolling(tab === 'overview'); return () => setServerPolling(false); }, [tab]);

  const hide = () => { void back().then(() => setPref('dev.enabled', false)); };

  return (
    <div class="rl-sidepage app-dev" aria-label="Для разработчиков">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Для разработчиков" onClose={() => void back()} />
      <div class="app-dev-tabs">
        <FolderTabs label="Вкладки раздела" active={tab} onChange={(t: DevTab) => setGlobal({ devTab: t })}
          items={TABS.map((t) => ({ id: t, label: LABELS[t], count: t === 'errors' && errs ? errs : undefined }))} />
      </div>
      <div class="app-dev-pages">
        <SlideStack variant="tabs" order={TABS} active={tab} render={(k: DevTab) => (
          k === 'overview' ? <DevOverview onHide={hide} /> : k === 'log' ? <DevLog /> : k === 'network' ? <DevNetwork /> : k === 'data' ? <DevData /> : <DevErrors />
        )} />
      </div>
    </div>
  );
}

/** Что включено в имитаторе — для плашки. */
export function simText(s: DevSimFlags): string {
  const parts: string[] = [];
  if (s.offline) parts.push('офлайн');
  if (s.profile) parts.push(s.profile.lossPct >= 10 && s.profile.latency >= 1500 ? 'плохая сеть' : 'медленная сеть');
  if (s.dropNextUpdates) parts.push('дыра в журнале');
  if (s.forceTooLong) parts.push('снимок');
  return parts.join(', ');
}

/** Плашка «Режим разработчика: …» над приложением, пока включён любой режим имитатора (во всех вкладках). Клик — вкладка «Сеть». */
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
