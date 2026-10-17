import { CheckRow, InfoRow, Section, SelectRow, Switch, TextField } from '@relay/ui';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useDevStats } from '../../devtools/session';
import { useGlobal } from '../../global';
import { devCall, showToast } from '../../settingsData';

interface Profile { latency: number; jitter: number; lossPct: number; kbps: number }
type Preset = 'none' | '3g' | 'bad' | 'custom';
const PRESETS: Record<'3g' | 'bad', Profile> = {
  '3g': { latency: 300, jitter: 0, lossPct: 0, kbps: 400 },
  bad: { latency: 1500, jitter: 0, lossPct: 10, kbps: 0 },
};
const OPTIONS = [
  { value: 'none', label: 'Нет' },
  { value: '3g', label: '3G (300 мс, 400 Кбит/с)' },
  { value: 'bad', label: 'Плохая (1500 мс, 10 % потерь)' },
  { value: 'custom', label: 'Своя' },
];
const same = (a: Profile | null, b: Profile | null) => !!a && !!b && a.latency === b.latency && a.jitter === b.jitter && a.lossPct === b.lossPct && a.kbps === b.kbps;
const presetOf = (p: Profile | null): Preset => (!p ? 'none' : same(p, PRESETS['3g']) ? '3g' : same(p, PRESETS.bad) ? 'bad' : 'custom');
const clamp = (v: string, max: number) => { const n = Math.round(Number(v.replace(',', '.'))); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };

/** «Сеть»: имитатор транспорта движка (только этот браузер, сервер не меняется). Переключатели — сразу, подтверждение — со снимком. */
export function DevNetwork() {
  const sim = useGlobal((s) => s.devSim);
  const stats = useDevStats() as Record<string, any> | null;
  const persistKnown = stats?.sim?.persist as boolean | undefined;
  const [offline, setOffline] = useState(!!sim?.offline);
  const [preset, setPreset] = useState<Preset>(presetOf(sim?.profile ?? null));
  const [custom, setCustom] = useState<Profile>(sim?.profile && presetOf(sim.profile) === 'custom' ? sim.profile : { latency: 200, jitter: 50, lossPct: 0, kbps: 0 });
  const [persist, setPersist] = useState(!!sim?.persist);
  const local = useRef(0);   // своя правка ещё не подтверждена движком — не перетирать её снимком

  // правка из другой вкладки или после перезапуска — подхватываем, если своей неподтверждённой нет
  useEffect(() => {
    if (Date.now() - local.current < 1500) return;
    setOffline(!!sim?.offline);
    const p = presetOf(sim?.profile ?? null);
    setPreset(p);
    if (p === 'custom' && sim?.profile) setCustom(sim.profile);
  }, [sim]);
  useEffect(() => { if (persistKnown !== undefined && Date.now() - local.current > 1500) setPersist(persistKnown); }, [persistKnown]);

  const run = (cmd: string, args?: unknown, ok?: string) => {
    local.current = Date.now();
    devCall(cmd, args).then(() => { if (ok) showToast(ok); }, () => showToast('Не удалось выполнить команду'));
  };
  const applyProfile = (p: Preset, c = custom) => run('netProfile', { profile: p === 'none' ? null : p === 'custom' ? c : PRESETS[p], persist });
  const editCustom = (k: keyof Profile, max: number) => (v: string) => { const next = { ...custom, [k]: clamp(v, max) }; setCustom(next); applyProfile('custom', next); };

  return (
    <div class="rl-settings app-dev-scroll">
      <Section title="Соединение" footer="Влияет только на этот браузер. Движок закрывает сокет и не переподключается, HTTP-запросы движка отвечают ошибкой сети.">
        <InfoRow icon="wifiOff" title="Симулировать офлайн" trailing={<Switch id="dev-offline" label="Симулировать офлайн" checked={offline} onChange={(e: Event) => { const on = (e.currentTarget as HTMLInputElement).checked; setOffline(on); run('offline', { on, persist }); }} />} />
        <SelectRow label="Медленная сеть" value={preset} options={OPTIONS} onChange={(v: Preset) => { setPreset(v); applyProfile(v); }} />
        {preset === 'custom' ? (
          <div class="app-dev-custom">
            <TextField label="Задержка, мс" inputMode="numeric" value={String(custom.latency)} onInput={editCustom('latency', 30_000)} />
            <TextField label="Джиттер, мс" inputMode="numeric" value={String(custom.jitter)} onInput={editCustom('jitter', 10_000)} />
            <TextField label="Потери, %" inputMode="numeric" value={String(custom.lossPct)} onInput={editCustom('lossPct', 100)} />
          </div>
        ) : null}
        <CheckRow label="Сохранять после перезагрузки" subtitle="Офлайн и медленная сеть останутся включёнными" checked={persist} onChange={(on: boolean) => { setPersist(on); run('persist', { on }); }} />
      </Section>
      <Section title="Проверки" footer="Разрыв — код 4000, как обрыв: движок переподключится и догонит журнал через sync.">
        <InfoRow icon="close" title="Разорвать сокет" subtitle="Переподключение и догон" onClick={() => run('dropSocket', undefined, 'Сокет разорван')} />
        <InfoRow icon="alert" title="Дыра в журнале" subtitle="Выбросить один входящий updates" onClick={() => run('dropNextUpdates', undefined, 'Следующий updates будет выброшен')} />
        <InfoRow icon="history" title="Принудительный снимок" subtitle="Как будто пришёл tooLong" onClick={() => run('forceTooLong', undefined, 'Снимок запрошен')} />
      </Section>
    </div>
  );
}
