import { ChatBanner } from './ChatBanner';
import { UpdatePill } from './UpdatePill';
import { Avatar, ChatRow, Highlight, Icon, MenuPopover, Presence, SlideStack, ChatRowSkeleton, useMinVisible, EmptyState, WindowList, FolderTabs, SidebarCard, SidebarHeader, peerTone, ripple } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { loadMoreChats, openChat, prepareChat } from '../data';
import { pressOpen } from './press';
import { usePerson } from '../people';
import { closeSearch, openSearch } from '../search';
import { GlobalSearch } from './search/GlobalSearch';
import { setGlobal, useGlobal } from '../global';
import { useEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { go } from '../nav';
import { isDark } from '../theme';
import { chatTime, chatTone, isSystemChat, shownBody, snippet } from './format';
import { applyTheme as setTheme } from '../theme';
import { previewBody, previewText, previewThumb, type LastMessage } from './preview';
import { ALL, inFolder, toggleChatInFolder } from '../folders';
import { saveFolder, showToast } from '../settingsData';
import { selectFolder, useFolderCtx, useFolderGuard, useFolderItems, useFolderMenu, useFolderPlace } from './folderNav';
import { Button } from '@relay/ui';
import { isMuted, toggleMute } from '../mute';
import { seen } from '../data';
import { getGlobal } from '../global';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../profilePhoto';

const rowPhoto = (p: ProfilePhoto | null) => { const a = avatarPhoto(p); return { avatarSrc: a.src, avatarThumb: a.thumb }; };


/** Фрагмент вокруг совпадения: превью узкое, а совпадение может быть в конце длинного сообщения. */
/**
 * «Загружаем ещё чаты» внизу списка: крутится, только пока виден — вне экрана бесконечная анимация зря будит стили каждый кадр.
 * Пока виден — сам догружает страницу за страницей (как в Telegram Web K): в своей папке новая страница диалогов
 * может не добавить ни одной строки, и без этого спиннер висел бы вечно — список больше не просил продолжения.
 */
function MoreLoader() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const cursor = useGlobal((s) => s.status.chatsCursorAt);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // виден — следующая страница; пришла (курсор сдвинулся), а он всё ещё виден — ещё одна (движок не пустит два запроса сразу)
  useEffect(() => { if (on) loadMoreChats(); }, [on, cursor]);
  return (
    <div ref={ref} class={on ? 'app-more app-more-on' : 'app-more'} role="status" aria-label="Загружаем ещё чаты">
      <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 44" /></svg>
    </div>
  );
}

/** Строка списка чатов. memo: чат не изменился (тот же объект из Mirror) — строку не трогаем при сдвиге окна. */
const SideRow = memo(function SideRow({ c, meId, active, showDraft, muted, onMenu }: { c: Item; meId: number; active: boolean; showDraft: boolean; muted: boolean; onMenu: (id: number, x: number, y: number) => void }) {
  const last = c.last as (LastMessage & { status: string }) | null;
  const thumb = last ? previewThumb(last) : null;
  // имя автора — только в группах (в личке и так ясно, кто пишет); своё — «Вы», чужое — первое слово имени
  const group = c.kind === 'group' && last && !last.deleted && !last.service;   // служебное событие — без «Имя:», текст сам называет автора
  // чужой автор последнего в группе — и для «Имя:», и для текста служебного события (previewBody)
  const sender = usePerson(c.kind === 'group' && last && !last.deleted && last.senderId !== meId ? last.senderId : null);
  const name = group ? sender?.name : undefined;
  const author = !group ? undefined : last.senderId === meId ? 'Вы' : name ? name.split(' ')[0] : undefined;
  const draft = showDraft ? c.draft as string : '';
  return (
    <ChatRow
      name={(c.title as string) || 'Чат №' + c.id}
      avatarTone={chatTone(c)}
      {...rowPhoto(c.photo as ProfilePhoto | null)}
      logo={isSystemChat(c)}
      verified={isSystemChat(c)}
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
      {...pressOpen(() => prepareChat(c.id as number), () => openChat(c.id as number))}
      onContextMenu={(e: MouseEvent) => { e.preventDefault(); onMenu(c.id as number, e.clientX, e.clientY); }}
    />
  );
});

const ROW = 72; // высота строки чата (--size-row) — список виртуальный, строки фиксированной высоты


export function Sidebar() {
  const [menu, setMenu] = useState<HTMLElement | null>(null);   // главное меню: у кнопки ☰
  // контекстное меню строки чата (правая кнопка): как в Telegram — у курсора
  const [rowMenu, setRowMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const onRowMenu = useRef((id: number, x: number, y: number) => setRowMenu({ id, x, y })).current;
  // глобальный поиск — свой режим колонки (search/GlobalSearch): вкладки, недавние, выдача по всем чатам
  const searchOpen = useGlobal((s) => s.searchOpen);
  // список возвращается из поиска — с мягким проявлением (только в этот момент, не при загрузке страницы)
  const [fromSearch, setFromSearch] = useState(false);
  const wasSearch = useRef(searchOpen);
  useEffect(() => {
    if (wasSearch.current && !searchOpen) { setFromSearch(true); const t = setTimeout(() => setFromSearch(false), 300); wasSearch.current = searchOpen; return () => clearTimeout(t); }
    wasSearch.current = searchOpen;
  }, [searchOpen]);
  const theme = useGlobal((s) => s.theme);
  useGlobal((s) => s.prefs.timeFormat);   // смена формата времени перерисовывает время в списке
  const dark = isDark(theme);
  const view = useGlobal((s) => s.sidebarView);
  useEffect(() => { if (view !== 'chats') setMenu(null); }, [view]);   // ушли на другой экран — меню закрыто
  const me = useGlobal((s) => s.me)!;
  const chats = useGlobal((s) => s.chats);
  const folders = useGlobal((s) => s.settings.folders);
  const place = useFolderPlace();
  const items = useFolderItems();
  const folderMenu = useFolderMenu();
  const ctx = useFolderCtx();
  useFolderGuard();
  // Ctrl+Shift+1…9 — папка по номеру (как в Telegram Web A)
  useEffect(() => {
    if (place === 'none') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const t = items[Number(e.code.slice(5)) - 1];
        if (t) { e.preventDefault(); selectFolder(t.id); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [place, items]);
  const status = useGlobal((s) => s.status);
  const folder = useGlobal((s) => s.folder);
  const search = useGlobal((s) => s.search);
  const openId = useGlobal((s) => s.pendingChatId ?? s.openChatId);
  const loaded = useGlobal((s) => s.chatsLoaded);
  useGlobal((s) => s.muteTick);   // истёк срок «Отключить звук» — строки перерисовать
  // стадия в плейсхолдере поиска: короткие (до 400 мс) не показываем, показанную держим не меньше 800 мс
  const searchStatus = useGlobal((s) => s.syncLabel);
  // данных ещё нет: ждём снимок из кэша или первую загрузку с сервера
  const waiting = !loaded || (!chats.length && !status.hydrated && status.phase !== 'offline');
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600 });
  // скелетон уходит — список проявляется чуть позже, когда скелетон почти погас (не поверх него: строки
  // скелетона и настоящие диалоги не должны быть видны одновременно). Считаем в том же рендере, где список
  // появляется: класс, добавленный позже, сдвинул бы уже идущую анимацию
  const prevSkeleton = useRef(skeleton);
  const lateUntil = useRef(0);
  if (prevSkeleton.current && !skeleton) lateUntil.current = performance.now() + 700;
  prevSkeleton.current = skeleton;
  const late = performance.now() < lateUntil.current;

  const q = search.trim().toLowerCase();
  // «Все» — только непрерывно загруженный диапазон (как в Telegram): старые непрочитанные из-за курсора
  // покажутся, когда до них дойдёт подгрузка, а не висят внизу, над которыми потом вставляются страницы
  const loadedFrom = status.chatsComplete || !status.chatsCursorAt ? 0 : status.chatsCursorAt;
  // своя папка — фильтр того же загруженного диапазона (у папок нет своей выдачи на сервере: у края
  // списка догружаем общие диалоги, как в Telegram Web K)
  const listOf = (id: number) => {
    const f = id === ALL ? null : folders.find((x) => x.id === id) ?? null;
    return chats.filter((c) =>
      Date.parse(c.lastAt as string) >= loadedFrom &&
      (!f || inFolder(f, c as never, ctx)) &&
      (!q || String(c.title ?? '').toLowerCase().includes(q)));
  };
  // вкладки показываются, только когда есть свои папки; иначе (и при вкладках слева) — одна страница «Все»
  const shown = place === 'none' ? ALL : folder;
  const order = place === 'none' ? [String(ALL)] : items.map((t) => String(t.id));

  // одна папка: свой список и своя прокрутка (страница SlideStack)
  const renderFolder = (key: string) => {
    const f = Number(key);
    const list = listOf(f);
    return (
      <>
      <div class={'app-listwrap' + (late ? ' is-late' : '')}>
        <Presence show={skeleton} exitMs={200}>
          <div class="app-skel" aria-busy="true" aria-label="Загрузка чатов">
            {Array.from({ length: 9 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
          </div>
        </Presence>
        {waiting || skeleton ? null : list.length ? (
          <>
          <WindowList
            role="list"
            items={list}
            onNearEnd={!status.chatsComplete ? loadMoreChats : undefined}
            rowHeight={ROW}
            getKey={(c: Item) => 'c' + c.id}
            render={(c: Item) => <SideRow c={c} meId={me.userId} active={c.id === openId} showDraft={!!c.draft && c.id !== openId} muted={isMuted(c)} onMenu={onRowMenu} />}
          />
          {!q && !status.chatsComplete ? (
            <MoreLoader />
          ) : null}
          </>
        ) : f !== ALL && !q && !status.chatsComplete ? (
          <MoreLoader />
        ) : f !== ALL && !q ? (
          <div class="app-folder-empty">
            <EmptyState kind="chats" title="В папке нет чатов" text="Сюда попадут чаты, подходящие под правила папки." />
            <Button variant="primary" onClick={() => void go('settings/folders/' + f)}>Изменить папку</Button>
          </div>
        ) : (
          <EmptyState
            kind={q ? 'search' : 'chats'}
            title={q ? 'Ничего не найдено' : !status.hydrated ? 'Нет сети' : 'Пока нет чатов'}
            text={q ? 'Поиск идёт по чатам на устройстве.' : !status.hydrated ? 'Чаты загрузятся, когда появится подключение.' : 'Нажмите карандаш, чтобы начать переписку.'}
          />
        )}
        </div>

      </>
    );
  };

  return (
    <SidebarCard
      class={fromSearch ? 'app-from-search' : undefined}
      embedded
      paged
      header={<SidebarHeader onMenu={(e: MouseEvent) => setMenu(e.currentTarget as HTMLElement)} back={searchOpen} onBack={closeSearch} status={searchStatus ?? undefined} searchId="side-search" value={search} placeholder="Поиск"
        onSearchFocus={openSearch} onSearchKey={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}
        onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value, searchOpen: true })} />}
      top={!searchOpen ? <ChatBanner /> : null}
      tabs={place === 'top' && !searchOpen ? <FolderTabs class="app-folders" active={folder} onChange={selectFolder} onItemMenu={folderMenu.open} items={items.map((t, i) => (i === 0 ? { ...t, label: 'Все' } : t))} /> : null}
      banner={
        <>
          <RowMenu at={rowMenu} onClose={() => setRowMenu(null)} />
          <MenuPopover
                open={!!menu && view === 'chats'} anchor={menu ?? undefined} placement="bottom-start" class="app-sidemenu"
                label="Главное меню"
                onClose={() => setMenu(null)}
                menuHeader={
                  <button type="button" role="menuitem" class="rl-menu-item app-menu-profile" onClick={() => { setMenu(null); void go('settings'); }}>
                    <Avatar name={me.name} tone={peerTone(me.userId)} size={32} {...avatarPhoto(me.photo)} /><span>{me.name}</span>
                  </button>
                }
                items={[
                  '-',   // под профилем — разделитель, как в Telegram
                  { icon: 'account', label: 'Мой профиль', onClick: () => { setMenu(null); void go('settings'); } },
                  { icon: 'contact', label: 'Контакты', onClick: () => { setMenu(null); void go('contacts'); } },
                  { icon: 'settings', label: 'Настройки', onClick: () => { setMenu(null); void go('settings'); } },
                  '-',
                  { icon: 'more', label: 'Ещё', submenu: [
                    { icon: 'moon', label: 'Ночной режим', checked: dark, keepOpen: true, onClick: () => setTheme(dark ? 'light' : 'dark') },
                  ] },
                ]}
              />
        </>
      }
      fab={searchOpen ? undefined : <NewChatFab />}
      overlay={<UpdatePill />}
    >
      {searchOpen ? <GlobalSearch /> : <SlideStack variant="tabs" order={order} active={String(shown)} render={(f: string) => <div class="rl-page-scroll">{renderFolder(f)}</div>} />}
      {folderMenu.node}
    </SidebarCard>
  );
}

/** Действия с чатом по правой кнопке: только то, что умеет сервер (удаления/закрепления/архива пока нет). */
function RowMenu({ at, onClose }: { at: { id: number; x: number; y: number } | null; onClose: () => void }) {
  const chat = useGlobal((s) => (at ? s.chats.find((c) => c.id === at.id) : undefined));
  const muted = isMuted(chat);
  const last = useRef(at);
  if (at) last.current = at;
  const p = at ?? last.current;
  const id = p?.id ?? 0;
  const folders = useGlobal((s) => s.settings.folders);
  const activeFolder = useGlobal((s) => s.folder);
  const ctx = useFolderCtx();
  // папки: «Добавить в папку» — подменю с галочками; внутри своей папки — ещё и «Убрать из папки»
  const toggleIn = (fid: number) => {
    const f = getGlobal().settings.folders.find((x) => x.id === fid);
    if (!f || !chat) return;
    onClose();
    saveFolder(toggleChatInFolder(f, chat as never, ctx)).catch(() => showToast('Не удалось изменить папку'));
  };
  const current = folders.find((x) => x.id === activeFolder);
  const folderItems = !chat || !folders.length ? [] : [
    { icon: 'folder', label: 'Добавить в папку', submenu: folders.map((f) => ({ icon: inFolder(f, chat as never, ctx) ? 'check' : 'folder', label: f.title, onClick: () => toggleIn(f.id) })) },
    ...(current && inFolder(current, chat as never, ctx) ? [{ icon: 'close', label: 'Убрать из папки', onClick: () => toggleIn(current.id) }] : []),
  ];
  const unread = (chat?.unread as number) > 0;
  const lastId = ((chat?.last as { id?: number | null } | null)?.id ?? 0) || (chat?.knownMaxId as number) || 0;
  return (
            <MenuPopover
              open={!!at && !!chat} anchor={p ?? undefined}
              label="Действия с чатом"
              onClose={onClose}
              items={[
                { icon: 'newTab', label: 'Открыть в новой вкладке', onClick: () => { onClose(); window.open(location.pathname + '#chat=' + id, '_blank', 'noopener'); } },
                ...(unread && lastId ? [{ icon: 'markRead', label: 'Отметить как прочитанное', onClick: () => { onClose(); seen(id, lastId); } }] : []),
                { icon: muted ? 'bell' : 'bellOff', label: muted ? 'Включить уведомления' : 'Выключить уведомления', onClick: () => { onClose(); toggleMute(id); } },
                ...folderItems,
                { icon: 'info', label: 'Информация', onClick: () => { onClose(); openChat(id); setGlobal({ infoOpen: true }); } },
              ]}
            />
  );
}

/** Карандаш внизу списка — как в Telegram: меню «Новая группа / Новое сообщение» над кнопкой, сама кнопка становится крестиком. */
function NewChatFab() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pick = (path: string) => { setOpen(false); void go(path); };
  return (
    <div class="app-newchat-fab">
      <MenuPopover open={open} anchor={btn.current ?? undefined} placement="top-end" label="Создать" onClose={() => setOpen(false)} items={[
            { icon: 'community', label: 'Новая группа', onClick: () => { setGlobal({ newGroup: null }); pick('newGroup'); } },
            { icon: 'contact', label: 'Новое сообщение', onClick: () => pick('contacts') },
          ]} />
      <button ref={btn} type="button" class={'rl-fab-main app-newchat-btn' + (open ? ' app-newchat-open' : '')} aria-label={open ? 'Закрыть' : 'Новый чат'}
        aria-expanded={open} aria-haspopup="menu" onPointerDown={ripple} onClick={() => setOpen(!open)}>
        <Icon name="pencilFilled" size={24} class="app-newchat-pencil" />   {/* как у Telegram: new-chat-filled */}
        <Icon name="close" size={24} class="app-newchat-close" />
      </button>
    </div>
  );
}
