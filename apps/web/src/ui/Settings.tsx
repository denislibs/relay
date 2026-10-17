import { InfoRow, PanelHeader, Switch } from '@relay/ui';
import { setNotify } from '../notify';
import { useGlobal } from '../global';
import { back } from '../nav';
import { useScrollMemory } from './useScrollMemory';


const NOTIFY_HINT: Record<string, string> = {
  on: 'Даже когда вкладка закрыта',
  off: 'Выключены на этом устройстве',
  default: 'Нужно разрешение браузера',
  denied: 'Запрещены в настройках браузера',
  unsupported: 'Браузер не поддерживает',
};

/** Прежние группы настроек живут на страницах разделов, пока их не заменят полноценные (B-задачи). */
export function LegacyPage({ path, title }: { path: string; title: string }) {
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const notify = useGlobal((s) => s.notify);
  const pushReady = useGlobal((s) => s.pushReady);
  const scroll = useScrollMemory(path);
  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
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

