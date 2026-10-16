import { Banner, ChatRow, EmptyState, Fab, FlipList, FolderTabs, Presence, SidebarCard, SidebarHeader } from '@relay/ui';
import { openChat } from '../data';
import { setGlobal, useGlobal } from '../global';
import { chatTime } from './format';

export function Sidebar() {
  const me = useGlobal((s) => s.me)!;
  const chats = useGlobal((s) => s.chats);
  const counters = useGlobal((s) => s.counters);
  const status = useGlobal((s) => s.status);
  const folder = useGlobal((s) => s.folder);
  const search = useGlobal((s) => s.search);
  const openId = useGlobal((s) => s.openChatId);

  const q = search.trim().toLowerCase();
  const list = chats.filter((c) => (folder === 'all' || (c.unread as number) > 0) && (!q || String(c.title ?? '').toLowerCase().includes(q)));

  return (
    <SidebarCard
      header={<SidebarHeader me={me.name} searchId="side-search" value={search} placeholder="Поиск" onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value })} />}
      tabs={<FolderTabs active={folder} onChange={(id: 'all' | 'unread') => setGlobal({ folder: id })} items={[
        { id: 'all', label: 'Все', count: counters.unreadChats },
        { id: 'unread', label: 'Непрочитанные', count: counters.unreadMessages },
      ]} />}
      banner={
        <Presence show={!status.online}>
          <div style={{ padding: '0 12px 8px' }}>
            <Banner icon="wifiOff" tone="warn">
              Нет сети. Показываем сохранённое на устройстве{status.outbox ? `, в очереди: ${status.outbox}` : ''}.
            </Banner>
          </div>
        </Presence>
      }
      fab={<Fab label="Новый чат" onClick={() => setGlobal({ newChatOpen: true })} />}
    >
      {list.length ? (
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
    </SidebarCard>
  );
}
