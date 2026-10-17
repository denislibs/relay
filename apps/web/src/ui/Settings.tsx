import { Icon, InfoRow, PanelHeader, ProfileHeader, Switch, peerTone } from '@relay/ui';
import { setNotify } from '../notify';
import { useEffect } from 'preact/hooks';
import { setGlobal, useGlobal } from '../global';
import { applyTheme, type ThemePref } from '../theme';

declare const __BUILD__: string;

const THEMES: { pref: ThemePref; icon: string; title: string }[] = [
  { pref: 'system', icon: 'palette', title: 'Как в системе' },
  { pref: 'light', icon: 'sun', title: 'Светлая' },
  { pref: 'dark', icon: 'moon', title: 'Тёмная' },
];

export function setTheme(pref: ThemePref): void {
  applyTheme(pref);
  setGlobal({ theme: pref });
}

const NOTIFY_HINT: Record<string, string> = {
  on: 'Даже когда вкладка закрыта',
  off: 'Выключены на этом устройстве',
  default: 'Нужно разрешение браузера',
  denied: 'Запрещены в настройках браузера',
  unsupported: 'Браузер не поддерживает',
};

const back = () => setGlobal({ sidebarView: 'chats' });

export function Settings() {
  const me = useGlobal((s) => s.me)!;
  const theme = useGlobal((s) => s.theme);
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const notify = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);

  // Esc — назад к чатам, как стрелка
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') back(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="rl-sidepage" aria-label="Настройки">
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title="Настройки" onClose={back} />
      <div class="rl-settings">
        <ProfileHeader name={me.name} tone={peerTone(me.userId)} subtitle={status.phase === 'offline' ? 'нет сети' : 'в сети'} size={96} />
        <div class="rl-settings-group" role="radiogroup" aria-label="Тема">
          <div class="rl-settings-caption">Тема</div>
          {THEMES.map((t) => (
            <InfoRow
              key={t.pref}
              icon={t.icon}
              title={t.title}
              onClick={() => setTheme(t.pref)}
              trailing={theme === t.pref ? <span class="rl-check-mark" aria-label="выбрано"><Icon name="check" size={22} /></span> : null}
            />
          ))}
        </div>
        <div class="rl-settings-group">
          <div class="rl-settings-caption">Уведомления</div>
          <InfoRow
            icon={notify === 'on' ? 'bell' : 'bellOff'}
            title="Новые сообщения"
            subtitle={notify === 'on' && !pushReady ? 'Пока открыта вкладка' : NOTIFY_HINT[notify]}
            trailing={<Switch id="settings-notify" label="Уведомления о сообщениях" checked={notify === 'on'} disabled={notify === 'unsupported' || notify === 'denied'} onChange={() => setNotify(notify !== 'on')} />}
          />
        </div>
        <div class="rl-settings-group">
          <div class="rl-settings-caption">Данные</div>
          <InfoRow icon="cloud" title="Чаты на устройстве" subtitle={`${chats} — доступны без сети`} />
          <InfoRow icon="history" title="Синхронизация" subtitle={status.phase === 'ready' ? (status.outbox ? `В очереди: ${status.outbox}` : 'Всё сохранено на сервере') : status.phase === 'offline' ? 'Ждём сеть' : 'Идёт обновление'} />
        </div>
        <div class="rl-settings-group">
          <div class="rl-settings-caption">О приложении</div>
          <InfoRow icon="info" title="Relay" subtitle={'Сборка ' + __BUILD__} />
        </div>
      </div>
    </div>
  );
}
