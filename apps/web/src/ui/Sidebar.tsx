import { ChatRow, Menu, Presence, SlideStack, ChatRowSkeleton, useMinVisible, EmptyState, Fab, WindowList, FolderTabs, SidebarCard, SidebarHeader } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { loadMoreChats, openChat } from '../data';
import { setGlobal, useGlobal } from '../global';
import { useState } from 'preact/hooks';
import { isDark } from '../theme';
import { chatTime } from './format';
import { setTheme } from './Settings';

const FOLDERS = ['all', 'unread'];
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
  const mutedIds = useGlobal((s) => s.muted);
  // стадия в плейсхолдере поиска: короткие (до 400 мс) не показываем, показанную держим не меньше 800 мс
  const searchStatus = useGlobal((s) => s.syncLabel);
  // данных ещё нет: ждём снимок из кэша или первую загрузку с сервера
  const waiting = !loaded || (!chats.length && !status.hydrated && status.phase !== 'offline');
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });

  const q = search.trim().toLowerCase();
  // «Все» — только непрерывно загруженный диапазон (как в Telegram): старые непрочитанные из-за курсора
  // покажутся, когда до них дойдёт подгрузка, а не висят внизу, над которыми потом вставляются страницы
  const loadedFrom = status.chatsComplete || !status.chatsCursorAt ? 0 : status.chatsCursorAt;
  const listOf = (f: string) => chats.filter((c) =>
    (f === 'all' ? Date.parse(c.lastAt as string) >= loadedFrom : (c.unread as number) > 0) &&
    (!q || String(c.title ?? '').toLowerCase().includes(q)));

  // одна папка: свой список и своя прокрутка (страница SlideStack)
  const renderFolder = (f: string) => {
    const list = listOf(f);
    return (
      <div class="app-listwrap">
        <Presence show={skeleton} exitMs={280}>
          <div class="app-skel" aria-busy="true" aria-label="Загрузка чатов">
            {Array.from({ length: 9 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
          </div>
        </Presence>
        {waiting || skeleton ? null : list.length ? (
          <>
          <WindowList
            role="list"
            items={list}
            onNearEnd={f === 'all' && !status.chatsComplete ? loadMoreChats : undefined}
            rowHeight={ROW}
            getKey={(c: Item) => 'c' + c.id}
            render={(c: Item) => {
              const last = c.last as { body: string; senderId: number; status: string } | null;
              return (
                <ChatRow
                  name={(c.title as string) || 'Чат №' + c.id}
                  preview={last?.body ?? 'Нет сообщений'}
                  draft={c.draft && c.id !== openId ? (c.draft as string) : undefined}
                  muted={mutedIds.includes(c.id as number)}
                  time={chatTime((c.sortAt ?? c.lastAt) as string)}
                  unread={c.unread as number}
                  status={last && last.senderId === me.userId ? last.status : null}
                  active={c.id === openId}
                  onClick={() => openChat(c.id as number)}
                />
              );
            }}
          />
          {f === 'all' && !status.chatsComplete ? (
            <div class="app-more" role="status" aria-label="Загружаем ещё чаты">
              <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 44" /></svg>
            </div>
          ) : null}
          </>
        ) : (
          <EmptyState
            kind={q ? 'search' : 'chats'}
            title={q ? 'Ничего не найдено' : !status.hydrated ? 'Нет сети' : f === 'unread' ? 'Всё прочитано' : 'Пока нет чатов'}
            text={q ? 'Поиск идёт по чатам на устройстве.' : !status.hydrated ? 'Чаты загрузятся, когда появится подключение.' : f === 'unread' ? '' : 'Нажмите карандаш, чтобы начать переписку.'}
          />
        )}
        </div>
    );
  };

  return (
    <SidebarCard
      embedded
      paged
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
      <SlideStack variant="tabs" order={FOLDERS} active={folder} render={(f: string) => <div class="rl-page-scroll">{renderFolder(f)}</div>} />
    </SidebarCard>
  );
}
