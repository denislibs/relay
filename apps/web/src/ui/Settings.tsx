import { Icon, InfoRow, PanelHeader, Switch } from '@relay/ui';
import { setNotify } from '../notify';
import { setGlobal, useGlobal } from '../global';
import { back } from '../nav';
import { useScrollMemory } from './useScrollMemory';
import { applyTheme, type ThemePref } from '../theme';


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

/** Прежние группы настроек живут на страницах разделов, пока их не заменят полноценные (B-задачи). */
export function LegacyPage({ path, title }: { path: string; title: string }) {
  const theme = useGlobal((s) => s.theme);
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const notify = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);
  const scroll = useScrollMemory(path);
  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
        {path === 'settings/general' ? (
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
        ) : null}
        {path === 'settings/notifications' ? (
          <div class="rl-settings-group">
            <div class="rl-settings-caption">Уведомления</div>
            <InfoRow
              icon={notify === 'on' ? 'bell' : 'bellOff'}
              title="Новые сообщения"
              subtitle={notify === 'on' && !pushReady ? 'Пока открыта вкладка' : NOTIFY_HINT[notify]}
              trailing={<Switch id="settings-notify" label="Уведомления о сообщениях" checked={notify === 'on'} disabled={notify === 'unsupported' || notify === 'denied'} onChange={() => setNotify(notify !== 'on')} />}
            />
          </div>
        ) : null}
        {path === 'settings/data' ? (
          <div class="rl-settings-group">
            <div class="rl-settings-caption">Данные</div>
            <InfoRow icon="cloud" title="Чаты на устройстве" subtitle={`${chats} — доступны без сети`} />
            <InfoRow icon="history" title="Синхронизация" subtitle={status.phase === 'ready' ? (status.outbox ? `В очереди: ${status.outbox}` : 'Всё сохранено на сервере') : status.phase === 'offline' ? 'Ждём сеть' : 'Идёт обновление'} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

