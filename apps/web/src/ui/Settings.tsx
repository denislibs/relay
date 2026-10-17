import { InfoRow, PanelHeader } from '@relay/ui';
import { useGlobal } from '../global';
import { back } from '../nav';
import { useScrollMemory } from './useScrollMemory';


/** Прежние группы настроек живут на страницах разделов, пока их не заменят полноценные (B-задачи). */
export function LegacyPage({ path, title }: { path: string; title: string }) {
  const chats = useGlobal((s) => s.chats.length);
  const status = useGlobal((s) => s.status);
  const scroll = useScrollMemory(path);
  return (
    <div class="rl-sidepage" aria-label={title}>
      <PanelHeader icon="arrowLeft" closeLabel="Назад" title={title} onClose={() => void back()} />
      <div class="rl-settings" ref={scroll.ref} onScroll={scroll.onScroll}>
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

