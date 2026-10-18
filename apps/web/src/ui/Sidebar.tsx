import { ChatBanner } from './ChatBanner';
import { UpdatePill } from './UpdatePill';
import { Avatar, ChatRow, Highlight, Menu, Presence, SlideStack, ChatRowSkeleton, useMinVisible, EmptyState, Fab, WindowList, FolderTabs, SidebarCard, SidebarHeader, peerTone } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { ensureNames, loadMoreChats, openChat, openInner, searchMessages } from '../data';
import { setGlobal, useGlobal } from '../global';
import { useEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { SearchHit } from '@relay/sync-engine/src/types';
import { go } from '../nav';
import { isDark } from '../theme';
import { chatTime, chatTone, shownBody, snippet } from './format';
import { applyTheme as setTheme } from '../theme';
import { previewBody, previewText, previewThumb, type LastMessage } from './preview';

const FOLDERS = ['all', 'unread'];

/** Фрагмент вокруг совпадения: превью узкое, а совпадение может быть в конце длинного сообщения. */
/** «Загружаем ещё чаты» внизу списка: крутится, только пока виден — вне экрана бесконечная анимация зря будит стили каждый кадр. */
function MoreLoader() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} class={on ? 'app-more app-more-on' : 'app-more'} role="status" aria-label="Загружаем ещё чаты">
      <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 44" /></svg>
    </div>
  );
}

/** Строка списка чатов. memo: чат не изменился (тот же объект из Mirror) — строку не трогаем при сдвиге окна. */
const SideRow = memo(function SideRow({ c, meId, active, showDraft, muted }: { c: Item; meId: number; active: boolean; showDraft: boolean; muted: boolean }) {
  const last = c.last as (LastMessage & { status: string }) | null;
  const thumb = last ? previewThumb(last) : null;
  // имя автора — только в группах (в личке и так ясно, кто пишет); своё — «Вы», чужое — первое слово имени
  const group = c.kind === 'group' && last && !last.deleted;
  const name = useGlobal((s) => (group && last.senderId !== meId ? s.names[last.senderId] : undefined));
  useEffect(() => { if (group && last.senderId !== meId) ensureNames([last.senderId]); }, [group, last?.senderId]);
  const author = !group ? undefined : last.senderId === meId ? 'Вы' : name ? name.split(' ')[0] : undefined;
  const draft = showDraft ? c.draft as string : '';
  return (
    <ChatRow
      name={(c.title as string) || 'Чат №' + c.id}
      avatarTone={chatTone(c)}
      author={author}
      thumb={thumb}
      preview={last ? previewBody(last, !!thumb) : 'Нет сообщений'}
      draft={draft ? previewText(draft, c.draftEntities as LastMessage['entities']) : undefined}
      muted={muted}
      typing={!!c.typing}
      time={chatTime((c.sortAt ?? c.lastAt) as string)}
      unread={c.unread as number}
      status={!draft && last && last.senderId === meId ? last.status : null}
      active={active}
      onClick={() => openChat(c.id as number)}
    />
  );
});

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
            render={(c: Item) => <SideRow c={c} meId={me.userId} active={c.id === openId} showDraft={!!c.draft && c.id !== openId} muted={mutedIds.includes(c.id as number)} />}
          />
          {f === 'all' && !q && !status.chatsComplete ? (
            <MoreLoader />
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
              preview={<Highlight text={snippet(shownBody(h), results.q)} query={results.q} />}
              time={chatTime(h.createdAt)}
              onClick={() => openInner(h.chatId, { id: h.id, sort: h.sort })}   // найденное — поверх открытого чата, «Назад» вернёт к нему
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
      header={<SidebarHeader onMenu={() => setMenu(true)} status={searchStatus ?? undefined} me={me.name} meTone={peerTone(me.userId)} searchId="side-search" value={search} placeholder="Поиск" onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value })} />}
      top={!search.trim() ? <ChatBanner /> : null}
      tabs={<FolderTabs class="app-folders" active={folder} onChange={(id: 'all' | 'unread') => setGlobal({ folder: id })} items={[
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
                    <Avatar name={me.name} tone={peerTone(me.userId)} size={32} /><span>{me.name}</span>
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
      overlay={<UpdatePill />}
    >
      <SlideStack variant="tabs" order={FOLDERS} active={folder} render={(f: string) => <div class="rl-page-scroll">{renderFolder(f)}</div>} />
    </SidebarCard>
  );
}
