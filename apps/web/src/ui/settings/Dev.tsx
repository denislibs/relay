import { FolderTabs, PanelHeader, SlideStack } from '@relay/ui';
import { useEffect, useState } from 'preact/hooks';
import { markErrorsSeen, newErrorCount, subscribeErrors } from '../../devtools/metrics';
import { openDevSession, setServerPolling } from '../../devtools/session';
import { setGlobal, useGlobal, type DevTab } from '../../global';
import { back } from '../../nav';
import { setPref } from '../../prefs';
import { DevData } from './DevData';
import { DevErrors } from './DevErrors';
import { DevLog } from './DevLog';
import { DevNetwork } from './DevNetwork';
import { DevOverview } from './DevOverview';
import { DevPerf } from './DevPerf';

const TABS: DevTab[] = ['overview', 'perf', 'log', 'network', 'data', 'errors'];
const LABELS: Record<DevTab, string> = { overview: 'Обзор', perf: 'Кадры', log: 'Журнал', network: 'Сеть', data: 'Данные', errors: 'Ошибки' };

/** Счётчик новых ошибок для вкладки (и сброс, пока вкладка открыта). */
function useNewErrors(active: boolean): number {
  const [n, setN] = useState(newErrorCount());
  useEffect(() => subscribeErrors(() => { if (active) markErrorsSeen(); setN(newErrorCount()); }), [active]);
  useEffect(() => { if (active) markErrorsSeen(); setN(newErrorCount()); }, [active]);
  return n;
}

/** «Для разработчиков» (скрытый раздел): вкладки Обзор / Кадры / Журнал / Сеть / Данные / Ошибки. Данные живут, только пока страница открыта. */
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
          k === 'overview' ? <DevOverview onHide={hide} /> : k === 'perf' ? <DevPerf /> : k === 'log' ? <DevLog /> : k === 'network' ? <DevNetwork /> : k === 'data' ? <DevData /> : <DevErrors />
        )} />
      </div>
    </div>
  );
}
