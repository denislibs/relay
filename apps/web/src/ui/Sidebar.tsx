import { Banner, ChatRow, ChatRowSkeleton, useMinVisible, EmptyState, Fab, FlipList, FolderTabs, Presence, SidebarCard, SidebarHeader } from '@relay/ui';
import { useRef } from 'preact/hooks';
import { openChat } from '../data';
import { setGlobal, useGlobal } from '../global';
import { chatTime } from './format';

export const PHASE_LABEL: Record<string, string> = {
  connecting: 'Подключение…',
  loading: 'Загрузка чатов…',
  updating: 'Обновление…',
  offline: 'Нет сети',
  ready: 'Синхронизировано',
};

export function Sidebar() {
  const me = useGlobal((s) => s.me)!;
  const chats = useGlobal((s) => s.chats);
  const counters = useGlobal((s) => s.counters);
  const status = useGlobal((s) => s.status);
  const folder = useGlobal((s) => s.folder);
  const search = useGlobal((s) => s.search);
  const openId = useGlobal((s) => s.openChatId);
  const loaded = useGlobal((s) => s.chatsLoaded);
  const lastLabel = useRef('');
  // стадия в плейсхолдере поиска: короткие (до 400 мс) не показываем, показанную держим не меньше 800 мс
  const busy = useMinVisible(status.phase === 'connecting' || status.phase === 'loading' || status.phase === 'updating', { delay: 400, min: 800 });
  // данных ещё нет: ждём снимок из кэша или первую загрузку с сервера
  const waiting = !loaded || (!chats.length && !status.hydrated && status.phase !== 'offline');
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  if (status.phase !== 'ready' && status.phase !== 'offline') lastLabel.current = PHASE_LABEL[status.phase]; // при исчезании строки держим прежнюю подпись

  const q = search.trim().toLowerCase();
  const list = chats.filter((c) => (folder === 'all' || (c.unread as number) > 0) && (!q || String(c.title ?? '').toLowerCase().includes(q)));

  return (
    <SidebarCard
      header={<SidebarHeader me={me.name} searchId="side-search" value={search} placeholder={busy ? lastLabel.current : 'Поиск'} onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value })} />}
      tabs={<FolderTabs active={folder} onChange={(id: 'all' | 'unread') => setGlobal({ folder: id })} items={[
        { id: 'all', label: 'Все' },
        { id: 'unread', label: 'Непрочитанные', count: counters.unreadChats },
      ]} />}
      banner={
        <>
          <Presence show={status.phase === 'offline'}>
            <div style={{ padding: '0 12px 8px' }}>
              <Banner icon="wifiOff" tone="warn">
                {status.hydrated ? 'Нет сети. Показываем сохранённое на устройстве' : 'Нет сети. Чаты загрузятся, когда появится подключение'}
                {status.outbox ? `, в очереди: ${status.outbox}` : ''}.
              </Banner>
            </div>
          </Presence>
        </>
      }
      fab={<Fab label="Новый чат" onClick={() => setGlobal({ newChatOpen: true })} />}
    >
      <div class="app-listwrap">
      <Presence show={skeleton} exitMs={280}>
        <div class="app-skel" aria-busy="true" aria-label="Загрузка чатов">
          {Array.from({ length: 9 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
        </div>
      </Presence>
      {waiting || skeleton ? null : list.length ? (
        <FlipList>
          {list.map((c) => {
            const last = c.last as { body: string; senderId: number; status: string } | null;
            return (
              <ChatRow
                key={'c' + c.id}
                name={(c.title as string) || 'Чат №' + c.id}
                preview={last?.body ?? 'Нет сообщений'}
                time={chatTime(c.lastAt as string)}
                unread={c.unread as number}
                status={last && last.senderId === me.userId ? last.status : null}
                active={c.id === openId}
                onClick={() => openChat(c.id as number)}
              />
            );
          })}
        </FlipList>
      ) : (
        <EmptyState
          kind={q ? 'search' : 'chats'}
          title={q ? 'Ничего не найдено' : folder === 'unread' ? 'Всё прочитано' : 'Пока нет чатов'}
          text={q ? 'Поиск идёт по чатам на устройстве.' : folder === 'unread' ? '' : 'Нажмите карандаш, чтобы начать переписку.'}
        />
      )}
      </div>
    </SidebarCard>
  );
}
