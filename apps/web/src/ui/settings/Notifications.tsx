import { CheckRow, ChatRowSkeleton, PanelHeader, Presence, RangeRow, Section, useMinVisible } from '@relay/ui';
import { useState } from 'preact/hooks';
import { getGlobal, useGlobal } from '../../global';
import { bgWanted, setBackground, setNotify } from '../../notify';
import { soundOn, toggleSound, volumeFromSlider, volumePct } from '../../notifyRules';
import { back } from '../../nav';
import { setPrefs } from '../../prefs';
import { refreshSettings, registerPrefetch, setNotifyDefault, showToast } from '../../settingsData';
import { playNotifySound } from '../../sound';
import { useScrollMemory } from '../useScrollMemory';

type Kind = 'direct' | 'group';

// предзагрузка: настройки с сервера уже лежат в движке, когда страница открывается (в первый раз — без скелета)
registerPrefetch('settings/notifications', () => { void refreshSettings(); });

/** Уведомления: на этом устройстве (браузер, звук) и умолчания аккаунта по видам чатов. */
export function Notifications() {
  const prefs = useGlobal((s) => s.prefs.notify);
  const state = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);
  const settings = useGlobal((s) => s.settings.notify);
  const loaded = useGlobal((s) => s.settings.loaded);
  const phase = useGlobal((s) => s.status.phase);
  // первый визит: значения с сервера ещё не пришли — скелет вместо секций, без перескока с умолчаний
  const waiting = !loaded && phase !== 'offline';
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  const [asking, setAsking] = useState(false);   // окно разрешения браузера открыто: переключатель уже включён
  const scroll = useScrollMemory('settings/notifications');
  const [bg, setBg] = useState(bgWanted);   // переключатель не ждёт ответа сервера

  const blocked = state === 'unsupported' || state === 'denied';
  const webOn = prefs.web && state === 'on';
  const webShown = webOn || asking;

  const toggleWeb = async (on: boolean) => {
    setAsking(on);
    await setNotify(on);   // первое включение спросит разрешение браузера (и сразу включит переключатель)
    setAsking(false);
    if (on && getGlobal().notify !== 'on') {   // отказ или закрыли запрос — откат
      setPrefs({ 'notify.web': false });
      if (getGlobal().notify === 'denied') showToast('Браузер запретил уведомления');
    }
  };
  const toggleBg = (on: boolean) => { setBg(on); void setBackground(on); };
  const apply = (p: { sound: boolean; volume: number }) => setPrefs({ 'notify.sound': p.sound, 'notify.volume': p.volume });
  const toggleSnd = (on: boolean) => {
    const p = toggleSound(prefs, on);
    apply(p);
    if (on) playNotifySound(p.volume);
  };
  const webHint = state === 'unsupported' ? 'Не поддерживается' : state === 'denied' ? 'Запрещено в браузере' : undefined;
  const bgHint = state === 'unsupported' ? 'Не поддерживается' : !webOn ? 'Сначала включите уведомления' : bg && pushReady ? 'Придут, даже если вкладка закрыта' : bg ? 'Пока открыта вкладка' : undefined;

  const kind = (k: Kind, title: string) => {
    const p = settings[k];
    return (
      <Section title={title}>
        <CheckRow label="Уведомления" checked={!p.muted} onChange={(on: boolean) => void setNotifyDefault(k, { muted: !on })} />
        <CheckRow label="Предпросмотр сообщений" checked={p.preview} disabled={p.muted} onChange={(on: boolean) => void setNotifyDefault(k, { preview: on })} />
      </Section>
    );
  };

  return (
    <div class="rl-sidepage" aria-label="Уведомления">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Уведомления" onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        <Section title="В браузере" footer="Действует на этом устройстве.">
          <CheckRow label="Уведомления" subtitle={webHint} checked={webShown} disabled={blocked} onChange={(on: boolean) => void toggleWeb(on)} />
          <CheckRow label="Когда вкладка закрыта" subtitle={bgHint} checked={bg && webOn} disabled={blocked || !webOn} onChange={toggleBg} />
        </Section>
        <Section title="Звук">
          <CheckRow label="Звук" checked={soundOn(prefs)} onChange={toggleSnd} />
          <RangeRow
            label="Громкость" min={0} max={100} step={1} value={volumePct(prefs.volume)} format={(v: number) => v + ' %'}
            onChange={(v: number) => apply(volumeFromSlider(v))}
            onCommit={(v: number) => playNotifySound(volumeFromSlider(v).volume)}
          />
        </Section>
        <div class="app-listwrap">
          <Presence show={skeleton} exitMs={280}>
            <div class="app-skel" aria-busy="true" aria-label="Загрузка настроек">
              <Section>{[0, 1].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
              <Section>{[0, 1].map((i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}</Section>
            </div>
          </Presence>
          {waiting || skeleton ? null : <>{kind('direct', 'Личные чаты')}{kind('group', 'Группы')}</>}
        </div>
      </div>
    </div>
  );
}
