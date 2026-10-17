import { Avatar, ChatRow, Highlight, Menu, Presence, SlideStack, ChatRowSkeleton, useMinVisible, EmptyState, Fab, WindowList, FolderTabs, SidebarCard, SidebarHeader } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { loadMoreChats, openChat, searchMessages } from '../data';
import { setGlobal, useGlobal } from '../global';
import { useEffect, useState } from 'preact/hooks';
import type { SearchHit } from '@relay/sync-engine/src/types';
import { go } from '../nav';
import { isDark } from '../theme';
import { chatTime } from './format';
import { applyTheme as setTheme } from '../theme';

const FOLDERS = ['all', 'unread'];

/** Превью последнего сообщения в строке чата. */
function previewOf(m: { deleted?: boolean; kind?: string; body: string; attachmentName?: string | null }): string {
  if (m.deleted) return 'Сообщение удалено';
  if (m.kind === 'photo') return '📷 ' + (m.body || 'Фото');
  if (m.kind === 'file') return '📎 ' + (m.body || m.attachmentName || 'Файл');
  return m.body;
}

/** Фрагмент вокруг совпадения: превью узкое, а совпадение может быть в конце длинного сообщения. */
function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i <= 24) return text;
  const from = text.lastIndexOf(' ', i - 12);
  return '…' + text.slice(from > 0 ? from + 1 : i - 12);
}
const ROW = 72; // высота строки чата (--size-row) — список виртуальный, строки фиксированной высоты


export function Sidebar() {
  const [menu, setMenu] = useState(false);
  // поиск сообщений (сервер, без сети — кэш): через 300 мс после последнего нажатия, от двух символов
  const [hits, setHits] = useState<{ q: string; list: SearchHit[]; source: string } | null>(null);
  const searchQ = useGlobal((s) => s.search).trim();
  useEffect(() => {
    if (searchQ.length < 2) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      searchMessages(searchQ).then((r) => { if (live) setHits({ q: searchQ, list: r.hits, source: r.source }); }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [searchQ]);
  const theme = useGlobal((s) => s.theme);
  useGlobal((s) => s.prefs.timeFormat);   // смена формата времени перерисовывает время в списке
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
    const results = f === 'all' && hits && hits.q === q.trim() ? hits : null;
    return (
      <>
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
                  preview={last ? previewOf(last as { deleted?: boolean; kind?: string; body: string; attachmentName?: string | null }) : 'Нет сообщений'}
                  draft={c.draft && c.id !== openId ? (c.draft as string) : undefined}
                  muted={mutedIds.includes(c.id as number)}
                  typing={!!c.typing}
                  time={chatTime((c.sortAt ?? c.lastAt) as string)}
                  unread={c.unread as number}
                  status={last && last.senderId === me.userId ? last.status : null}
                  active={c.id === openId}
                  onClick={() => openChat(c.id as number)}
                />
              );
            }}
          />
          {f === 'all' && !q && !status.chatsComplete ? (
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
      {results ? (
        <div class="app-results" aria-label="Найденные сообщения">
          <div class="app-results-head">Сообщения{results.source === 'local' ? ' · на устройстве' : ''}</div>
          {results.list.length ? results.list.map((h) => (
            <ChatRow
              key={'m' + h.id}
              name={h.chatTitle ?? 'Чат №' + h.chatId}
              preview={<Highlight text={snippet(h.body, results.q)} query={results.q} />}
              time={chatTime(h.createdAt)}
              onClick={() => openChat(h.chatId, { id: h.id, sort: h.sort })}
            />
          )) : <div class="app-results-empty">Сообщений не найдено</div>}
        </div>
      ) : null}
      </>
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
                header={
                  <button type="button" role="menuitem" class="rl-menu-item app-menu-profile" onClick={() => { setMenu(false); void go('settings'); }}>
                    <Avatar name={me.name} size={32} /><span>{me.name}</span>
                  </button>
                }
                items={[
                  { icon: 'account', label: 'Мой профиль', onClick: () => { setMenu(false); void go('settings'); } },
                  { icon: 'contact', label: 'Контакты', onClick: () => { setMenu(false); void go('contacts'); } },
                  { icon: 'settings', label: 'Настройки', onClick: () => { setMenu(false); void go('settings'); } },
                  '-',
                  { icon: 'more', label: 'Ещё', submenu: [
                    { icon: dark ? 'sun' : 'moon', label: dark ? 'Дневной режим' : 'Ночной режим', onClick: () => setTheme(dark ? 'light' : 'dark') },
                    { icon: 'pencil', label: 'Новый чат', onClick: () => setGlobal({ newChatOpen: true }) },
                  ] },
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
