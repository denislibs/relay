import { ChatRow, Menu, Presence, ChatRowSkeleton, useMinVisible, EmptyState, Fab, WindowList, FolderTabs, SidebarCard, SidebarHeader } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { openChat } from '../data';
import { setGlobal, useGlobal } from '../global';
import { useState } from 'preact/hooks';
import { isDark } from '../theme';
import { chatTime } from './format';
import { setTheme } from './Settings';

const ROW = 72; // высота строки чата (--size-row) — список виртуальный, строки фиксированной высоты


export function Sidebar() {
  const [menu, setMenu] = useState(false);
  const theme = useGlobal((s) => s.theme);
  const dark = isDark(theme);
  const view = useGlobal((s) => s.sidebarView);
  const me = useGlobal((s) => s.me)!;
  const chats = useGlobal((s) => s.chats);
  const counters = useGlobal((s) => s.counters);
  const status = useGlobal((s) => s.status);
  const folder = useGlobal((s) => s.folder);
  const search = useGlobal((s) => s.search);
  const openId = useGlobal((s) => s.pendingChatId ?? s.openChatId);
  const loaded = useGlobal((s) => s.chatsLoaded);
  // стадия в плейсхолдере поиска: короткие (до 400 мс) не показываем, показанную держим не меньше 800 мс
  const searchStatus = useGlobal((s) => s.syncLabel);
  // данных ещё нет: ждём снимок из кэша или первую загрузку с сервера
  const waiting = !loaded || (!chats.length && !status.hydrated && status.phase !== 'offline');
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });

  const q = search.trim().toLowerCase();
  const list = chats.filter((c) => (folder === 'all' || (c.unread as number) > 0) && (!q || String(c.title ?? '').toLowerCase().includes(q)));

  return (
    <SidebarCard
      embedded
      header={<SidebarHeader onMenu={() => setMenu(true)} status={searchStatus ?? undefined} me={me.name} searchId="side-search" value={search} placeholder="Поиск" onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value })} />}
      tabs={<FolderTabs active={folder} onChange={(id: 'all' | 'unread') => setGlobal({ folder: id })} items={[
        { id: 'all', label: 'Все' },
        { id: 'unread', label: 'Непрочитанные', count: counters.unreadChats },
      ]} />}
      banner={
        <>
          {menu ? <div class="rl-msgmenu-scrim" onClick={() => setMenu(false)} /> : null}
          {/* при переходе на другой экран меню снимаем сразу, без анимации исчезания поверх слайда */}
          {view === 'chats' ? <Presence show={menu} exitMs={160}>
            <div class="app-sidemenu">
              <Menu
                label="Главное меню"
                onClose={() => setMenu(false)}
                items={[
                  { icon: 'settings', label: 'Настройки', onClick: () => { setMenu(false); setGlobal({ sidebarView: 'settings' }); } },
                  { icon: dark ? 'sun' : 'moon', label: dark ? 'Дневной режим' : 'Ночной режим', onClick: () => setTheme(dark ? 'light' : 'dark') },
                  '-',
                  { icon: 'pencil', label: 'Новый чат', onClick: () => setGlobal({ newChatOpen: true }) },
                ]}
              />
            </div>
          </Presence> : null}
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
        <WindowList
          role="list"
          items={list}
          rowHeight={ROW}
          getKey={(c: Item) => 'c' + c.id}
          render={(c: Item) => {
            const last = c.last as { body: string; senderId: number; status: string } | null;
            return (
              <ChatRow
                name={(c.title as string) || 'Чат №' + c.id}
                preview={last?.body ?? 'Нет сообщений'}
                time={chatTime(c.lastAt as string)}
                unread={c.unread as number}
                status={last && last.senderId === me.userId ? last.status : null}
                active={c.id === openId}
                onClick={() => openChat(c.id as number)}
              />
            );
          }}
        />
      ) : (
        <EmptyState
          kind={q ? 'search' : 'chats'}
          title={q ? 'Ничего не найдено' : !status.hydrated ? 'Нет сети' : folder === 'unread' ? 'Всё прочитано' : 'Пока нет чатов'}
          text={q ? 'Поиск идёт по чатам на устройстве.' : !status.hydrated ? 'Чаты загрузятся, когда появится подключение.' : folder === 'unread' ? '' : 'Нажмите карандаш, чтобы начать переписку.'}
        />
      )}
      </div>
    </SidebarCard>
  );
}
