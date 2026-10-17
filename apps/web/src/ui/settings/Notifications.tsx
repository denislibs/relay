import { CheckRow, PanelHeader, RangeRow, Section } from '@relay/ui';
import { useState } from 'preact/hooks';
import { getGlobal, useGlobal } from '../../global';
import { bgWanted, setBackground, setNotify } from '../../notify';
import { soundOn, toggleSound, volumeFromSlider, volumePct } from '../../notifyRules';
import { back } from '../../nav';
import { getPrefs, setPref } from '../../prefs';
import { setNotifyDefault } from '../../settingsData';
import { playNotifySound } from '../../sound';
import { useScrollMemory } from '../useScrollMemory';

type Kind = 'direct' | 'group';

/** Уведомления: на этом устройстве (браузер, звук) и умолчания аккаунта по видам чатов. */
export function Notifications() {
  const prefs = useGlobal((s) => s.prefs.notify);
  const state = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);
  const settings = useGlobal((s) => s.settings.notify);
  const scroll = useScrollMemory('settings/notifications');
  const [bg, setBg] = useState(bgWanted);   // переключатель не ждёт ответа сервера

  const blocked = state === 'unsupported' || state === 'denied';
  const webOn = prefs.web && state === 'on';

  const toggleWeb = async (on: boolean) => {
    setPref('notify.web', on);
    await setNotify(on);   // первое включение спросит разрешение браузера
    if (on && getGlobal().notify !== 'on') setPref('notify.web', false);   // отказ или закрыли запрос — откат
  };
  const toggleBg = (on: boolean) => { setBg(on); void setBackground(on); };
  const apply = (p: { sound: boolean; volume: number }) => { setPref('notify.sound', p.sound); setPref('notify.volume', p.volume); };
  const toggleSnd = (on: boolean) => {
    const p = toggleSound(prefs, on);
    apply(p);
    if (on) playNotifySound(p.volume);
  };
  const webHint = state === 'unsupported' ? 'Не поддерживается' : state === 'denied' ? 'Запрещено в браузере' : undefined;
  const bgHint = state === 'unsupported' ? 'Не поддерживается' : !webOn ? 'Сначала включите уведомления' : bg && pushReady ? 'Придут, даже если вкладка закрыта' : bg ? 'Подключаем…' : undefined;

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
          <CheckRow label="Уведомления" subtitle={webHint} checked={webOn} disabled={blocked} onChange={(on: boolean) => void toggleWeb(on)} />
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
        {kind('direct', 'Личные чаты')}
        {kind('group', 'Группы')}
      </div>
    </div>
  );
}
