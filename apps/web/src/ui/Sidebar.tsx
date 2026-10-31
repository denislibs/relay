import { ChatBanner } from './ChatBanner';
import { UpdatePill } from './UpdatePill';
import { ArchivedRow, Avatar, ChatRow, Highlight, Icon, MenuPopover, Presence, SlideStack, ChatRowSkeleton, useMinVisible, EmptyState, WindowList, FolderTabs, SidebarCard, SidebarHeader, beginHeavyAnimation, peerTone, reducedMotion, ripple, addHotkeys } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { loadMoreChats, openChat, prepareChat } from '../data';
import { pressOpen } from './press';
import { clearUnreadMark, hasUnreadMark, isArchived, isPinned, markUnread, toggleArchive, togglePin } from '../chatFlags';
import { usePerson } from '../people';
import { closeSearch, openSearch } from '../search';
import { GlobalSearch } from './search/GlobalSearch';
import { NEXT_CHAT, PREV_CHAT } from '../shortcuts';
import { setGlobal, useGlobal } from '../global';
import { useEffect, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { go } from '../nav';
import { isDark } from '../theme';
import { chatTime, chatTone, isSystemChat, shownBody, snippet } from './format';
import { applyTheme as setTheme } from '../theme';
import { previewBody, previewText, previewThumb, type LastMessage } from './preview';
import { ALL, chatFolderTags, fitFolderTags, inFolder, toggleChatInFolder, type FolderTag } from '../folders';
import { saveFolder, showToast } from '../settingsData';
import { selectFolder, useFolderCtx, useFolderGuard, useFolderItems, useFolderMenu, useFolderPlace } from './folderNav';
import { Button } from '@relay/ui';
import { isMuted, toggleMute } from '../mute';
import { seen } from '../data';
import { getGlobal } from '../global';
import type { ProfilePhoto } from '@relay/protocol';
import { avatarPhoto } from '../profilePhoto';
import { installApp } from '../pwa';
import { startChatSelect, toggleChatSelect, type SelList } from '../chatSelect';
import { useChatSelectMode } from './chatSelectRun';
import { chatSelectDrag, dragClickGuard } from './chatSelectDrag';

/** Скелетон списка уже нарисован каркасом приложения из index.html (boot.js → html[data-shell-skel]). */
const SHELL_SKEL = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-shell-skel');

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
export const SideRow = memo(function SideRow({ c, meId, active, showDraft, muted, onMenu, tags, tagSpace, selecting, selected }: { c: Item; meId: number; active: boolean; showDraft: boolean; muted: boolean; onMenu: (id: number, x: number, y: number) => void; tags?: RowTag[]; tagSpace?: number; selecting?: boolean; selected?: boolean }) {
  const last = c.last as (LastMessage & { status: string; fwd?: boolean }) | null;
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
      data-chat-id={c.id}
      logo={isSystemChat(c)}
      verified={isSystemChat(c)}
      author={author}
      thumb={thumb}
      forwarded={!!last?.fwd && !last.deleted}
      preview={last ? previewBody(last, !!thumb) : 'Нет сообщений'}
      draft={draft ? previewText(draft, c.draftEntities as LastMessage['entities']) : undefined}
      muted={muted}
      typing={!!c.typing}
      time={chatTime((c.sortAt ?? c.lastAt) as string)}
      unread={c.unread as number}
      mentioned={(c.mentions as number) > 0}
      reactions={c.reactions as number}   // непросмотренные реакции на мои сообщения — красное сердце   // непрочитанное упоминание меня — «@» рядом со счётчиком
      unreadMark={hasUnreadMark(c)}
      pinned={isPinned(c)}
      status={!draft && last && last.senderId === meId ? last.status : null}
      active={active}
      tags={tags}
      tagSpace={tagSpace}
      fitTags={fitFolderTags}
      selecting={selecting}
      selected={selected}
      // в режиме выбора клик и правая кнопка только отмечают строку: чат не открывается, меню строки нет (как в tweb)
      {...(selecting ? { onClick: () => toggleChatSelect(c.id as number) } : pressOpen(() => prepareChat(c.id as number), () => openChat(c.id as number)))}
      onContextMenu={(e: MouseEvent) => { e.preventDefault(); if (selecting) toggleChatSelect(c.id as number); else onMenu(c.id as number, e.clientX, e.clientY); }}
    />
  );
});

const ROW = 72; // высота строки чата (--size-row) — список виртуальный, высоты строк известны без раскладки
const ROW_TAGGED = 82;   // строка с тегами папок (relay.css .rl-row-tagged)
const ROW_SIDE = 82;     // в строке не под текст: поля 9 + 9, аватар 54, зазор 10 — остальное ширина тегов

type RowTag = { id: number; title: string; tone: number };
// теги строки — тот же массив, пока они те же: строка (memo) не перерисовывается на каждом патче списка
const tagMemo = new Map<string, RowTag[]>();
function stableTags(key: string, tags: FolderTag[]): RowTag[] | undefined {
  if (!tags.length) { tagMemo.delete(key); return undefined; }
  const prev = tagMemo.get(key);
  if (prev && prev.length === tags.length && prev.every((t, i) => t.id === tags[i].id && t.title === tags[i].title && t.tone === tags[i].color)) return prev;
  const next = tags.map((t) => ({ id: t.id, title: t.title, tone: t.color }));
  tagMemo.set(key, next);
  return next;
}


let listShownAt = 0;   // когда список чатов впервые показан с данными (проявление — только тогда)

const SEARCH_MS = 150;   // как zoomFade у Telegram

export function Sidebar() {
  const [menu, setMenu] = useState<HTMLElement | null>(null);   // главное меню: у кнопки ☰
  // контекстное меню строки чата (правая кнопка): как в Telegram — у курсора
  const [rowMenu, setRowMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const onRowMenu = useRef((id: number, x: number, y: number) => setRowMenu({ id, x, y })).current;
  // глобальный поиск — свой режим колонки (search/GlobalSearch): вкладки, недавние, выдача по всем чатам
  const searchOpen = useGlobal((s) => s.searchOpen);
  // Переход в поиск и обратно — как zoomFade в Telegram: оба экрана на SEARCH_MS лежат друг на друге. Вход: список
  // с вкладками гаснет, поиск проявляется из 110%; выход: поиск гаснет, уходя в 110%, список возвращается из 95%.
  // Список не размонтируется (прокрутка и окно на месте). Переход считается прямо в рендере, где сменился режим:
  // через эффект первый кадр шёл бы без класса — список мелькал целиком и только потом начинал проявляться.
  const searchAnim = useRef<'in' | 'out' | null>(null);
  const wasSearch = useRef(searchOpen);
  const [, redrawSearch] = useState(0);
  if (wasSearch.current !== searchOpen) {
    wasSearch.current = searchOpen;
    searchAnim.current = reducedMotion() ? null : searchOpen ? 'in' : 'out';
  }
  useEffect(() => {
    const a = searchAnim.current;
    if (!a) return;
    const end = beginHeavyAnimation(SEARCH_MS);
    const t = setTimeout(() => { if (searchAnim.current === a) { searchAnim.current = null; redrawSearch((n) => n + 1); } end(); }, SEARCH_MS);
    return () => { clearTimeout(t); end(); };
  }, [searchOpen]);
  const searchLayer = searchOpen || searchAnim.current === 'out';
  const theme = useGlobal((s) => s.theme);
  useGlobal((s) => s.prefs.timeFormat);   // смена формата времени перерисовывает время в списке
  const dark = isDark(theme);
  const installable = useGlobal((s) => s.installable);
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
  // теги папок: только если у какой-то папки есть цвет. Ширина под них — от ширины списка (ResizeObserver
  // отдаёт размер без чтения раскладки), одна на все страницы папок
  const tagged = folders.some((f) => f.color !== null);
  const [tagSpace, setTagSpace] = useState(0);
  const tagRO = useRef<ResizeObserver | null>(null);
  const tagRef = useRef((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver !== 'function') return;
    tagRO.current ??= new ResizeObserver((es) => { const w = es[es.length - 1].contentRect.width; if (w > 0) setTagSpace(Math.floor(w - ROW_SIDE)); });
    tagRO.current.observe(el);
  }).current;
  useEffect(() => () => tagRO.current?.disconnect(), []);
  // Ctrl+Shift+1…9 — папка по номеру (как в Telegram Web A; Ctrl и на Mac)
  useEffect(() => {
    if (place === 'none') return;
    return addHotkeys(Array.from({ length: 9 }, (_, i): [string, () => false | void] => ['ctrl+shift+' + (i + 1), () => {
      const t = items[i];
      if (!t) return false;
      selectFolder(t.id);
    }]));
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
  // каркас из index.html уже показал скелетон списка (boot.js: прошлая загрузка была медленной) — свой такой же сразу,
  // с первого кадра и без всплытия строк: он ложится поверх каркасного, подмена не видна
  const skeleton = useMinVisible(waiting, { delay: 150, min: 600, immediate: SHELL_SKEL });
  // как в Telegram Web K: скелетон лежит слоем поверх списка; данные пришли — список уже под ним, а строки
  // скелетона стираются по одной (150 мс, сдвиг 15 мс) и открывают готовые диалоги — без пустого кадра
  // список, появившийся под скелетоном, своей анимации не получает и позже (снятие класса запустило бы её поверх стирания)
  const covered = useRef(false);
  if (waiting) covered.current = false;
  if (skeleton) covered.current = true;
  // проявление списка — только при первом приходе данных (окно 400 мс): страница папки, смонтированная при
  // переключении вкладки, иначе въезжала полупрозрачной, и сквозь строки «моргал» белый фон карточки
  if (!waiting && !listShownAt) listShownAt = performance.now();
  const fade = !covered.current && !waiting && performance.now() - listShownAt < 400;

  const q = search.trim().toLowerCase();
  // «Все» — только непрерывно загруженный диапазон (как в Telegram): старые непрочитанные из-за курсора
  // покажутся, когда до них дойдёт подгрузка, а не висят внизу, над которыми потом вставляются страницы
  const loadedFrom = status.chatsComplete || !status.chatsCursorAt ? 0 : status.chatsCursorAt;
  // своя папка — фильтр того же загруженного диапазона (у папок нет своей выдачи на сервере: у края
  // списка догружаем общие диалоги, как в Telegram Web K)
  const listOf = (id: number) => {
    const f = id === ALL ? null : folders.find((x) => x.id === id) ?? null;
    // архив — не в списках (только под строкой «Архив»; явно добавленный в папку — проверяет inFolder);
    // закреплённый — всегда, даже старше загруженного диапазона (движок грузит закреплённые сразу)
    return chats.filter((c) =>
      (f ? true : !isArchived(c)) &&
      (Date.parse(c.lastAt as string) >= loadedFrom || isPinned(c)) &&
      (!f || inFolder(f, c as never, ctx)) &&
      (!q || String(c.title ?? '').toLowerCase().includes(q)));
  };
  // вкладки показываются, только когда есть свои папки; иначе (и при вкладках слева) — одна страница «Все»
  const shown = place === 'none' ? ALL : folder;
  const order = place === 'none' ? [String(ALL)] : items.map((t) => String(t.id));
  // режим выбора — над строками открытой папки (пропавшие из неё выпадают из выбора)
  const mode = useChatSelectMode('main', listOf(shown));
  const rowTagSpace = mode.rowsSelecting ? Math.max(0, tagSpace - 36) : tagSpace;   // место под галочку сужает строку
  // Alt+↑ / Alt+↓ — соседний чат в открытой папке (как в Telegram); ни один не открыт — первый
  const stepRef = useRef<(d: number) => false | void>(() => false);
  stepRef.current = (d) => {
    const ids = listOf(shown).map((c) => c.id as number);
    if (!ids.length) return false;
    const at = openId == null ? -1 : ids.indexOf(openId);
    const next = at < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + d));
    if (ids[next] !== openId) openChat(ids[next]);
  };
  useEffect(() => addHotkeys([
    [PREV_CHAT, () => stepRef.current(-1), { repeat: true }],
    [NEXT_CHAT, () => stepRef.current(1), { repeat: true }],
  ]), []);

  // одна папка: свой список и своя прокрутка (страница SlideStack)
  // строка «Архив» над «Все» (как в Telegram): имена первых архивных, непрочитанные — ярче; счётчик — чаты с непрочитанным
  const archived = chats.filter(isArchived);
  const archiveNames = archived.slice(0, 5).map((c) => ({ name: String(c.title || 'Чат №' + c.id), unread: (c.unread as number) > 0 || hasUnreadMark(c) }));
  const archiveUnread = archived.filter((c) => (c.unread as number) > 0 || hasUnreadMark(c)).length;
  const renderFolder = (key: string) => {
    const f = Number(key);
    const list = listOf(f);
    // теги строк этой страницы (без тега открытой папки); нет цветных папок — null, все строки по 72
    let tagsOf: Map<number, RowTag[]> | null = null;
    if (tagged) {
      tagsOf = new Map();
      for (const c of list) {
        const t = stableTags(key + ':' + c.id, chatFolderTags(c as never, folders, ctx, f));
        if (t) tagsOf.set(c.id as number, t);
      }
    }
    return (
      <>
      <div ref={tagRef} class={'app-listwrap' + (fade ? ' is-fresh' : '') + mode.wrapClass}
        onPointerDownCapture={mode.sel ? (e) => chatSelectDrag(e, list, e.currentTarget.closest('.rl-page-scroll') as HTMLElement) : undefined}
        onClickCapture={mode.sel ? dragClickGuard : undefined}>
        <Presence show={skeleton} exitMs={320}>
          <div class={'app-skel' + (SHELL_SKEL ? ' app-skel-instant' : '')} aria-busy="true" aria-label="Загрузка чатов">
            {Array.from({ length: 9 }, (_, i) => <div key={i} style={{ '--i': i }}><ChatRowSkeleton /></div>)}
          </div>
        </Presence>
        {!waiting && f === ALL && !q && archived.length ? (
          <ArchivedRow names={archiveNames} count={archiveUnread} onClick={mode.sel ? undefined : () => void go('archive')} />
        ) : null}
        {waiting ? null : list.length ? (
          <>
          <WindowList
            keepAlive   // как в Telegram Web K: ушедшие за край строки не пересоздаются, возвращаются готовыми
            overscanPx={900}   // запас — около экрана (как окно в telegram-tt): ±288 px tweb при быстрой прокрутке давали пустоту
            role="list"
            items={list}
            // «Все» без поиска — сразу во всю высоту (сколько диалогов на сервере), незагруженное — скелетами
            total={f === ALL && !q && !status.chatsComplete ? status.chatsTotal : undefined}
            renderPlaceholder={() => <ChatRowSkeleton />}
            onPlaceholder={loadMoreChats}
            onNearEnd={!status.chatsComplete ? loadMoreChats : undefined}
            rowHeight={ROW}
            rowHeightOf={tagsOf ? (c: Item) => (tagsOf.get(c.id as number) ? ROW_TAGGED : ROW) : undefined}
            getKey={(c: Item) => 'c' + c.id}
            render={(c: Item) => <SideRow c={c} meId={me.userId} active={c.id === openId} showDraft={!!c.draft && c.id !== openId} muted={isMuted(c)} onMenu={onRowMenu} tags={tagsOf?.get(c.id as number)} tagSpace={rowTagSpace}
              selecting={mode.rowsSelecting} selected={!!mode.sel?.ids.includes(c.id as number)} />}
          />
          {!q && !status.chatsComplete && !(f === ALL && status.chatsTotal) ? (
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
      class={[searchOpen && 'app-searching', searchAnim.current && 'app-search-' + searchAnim.current].filter(Boolean).join(' ') || undefined}
      embedded
      paged
      // шапка выбора — соседка SidebarHeader: её позиционированный предок — .rl-sidepage, она ровно закрывает 62 px шапки
      header={<><SidebarHeader onMenu={(e: MouseEvent) => setMenu(e.currentTarget as HTMLElement)} back={searchOpen} onBack={closeSearch} status={searchStatus ?? undefined} searchId="side-search" value={search} placeholder="Поиск"
        onSearchFocus={openSearch} onSearchKey={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}
        onSearch={(e: Event) => setGlobal({ search: (e.target as HTMLInputElement).value, searchOpen: true })} />{mode.header}</>}
      top={<ChatBanner />}
      tabs={place === 'top' ? <FolderTabs class="app-folders" active={folder} onChange={selectFolder} onItemMenu={folderMenu.open} items={items.map((t, i) => (i === 0 ? { ...t, label: 'Все' } : t))} /> : null}
      banner={
        <>
          <RowMenu list="main" at={rowMenu} onClose={() => setRowMenu(null)} />
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
                  { icon: 'contacts', label: 'Контакты', onClick: () => { setMenu(null); void go('contacts'); } },
                  { icon: 'settings', label: 'Настройки', onClick: () => { setMenu(null); void go('settings'); } },
                  ...(installable ? [{ icon: 'download', label: 'Установить Relay', onClick: () => { setMenu(null); void installApp(); } }] : []),
                  '-',
                  { icon: 'more', label: 'Ещё', submenu: [
                    { icon: 'moon', label: 'Ночной режим', checked: dark, keepOpen: true, onClick: () => setTheme(dark ? 'light' : 'dark') },
                  ] },
                ]}
              />
        </>
      }
      fab={<NewChatFab />}
      overlay={<UpdatePill />}
    >
      <SlideStack variant="tabs" order={order} active={String(shown)} render={(f: string) => <div class="rl-page-scroll">{renderFolder(f)}</div>} />
      {searchLayer ? <div class="app-search-layer" inert={!searchOpen}><GlobalSearch /></div> : null}
      {folderMenu.node}
      {mode.node}
    </SidebarCard>
  );
}

/** Действия с чатом по правой кнопке: только то, что умеет сервер (удаления/закрепления/архива пока нет). */
export function RowMenu({ list, at, onClose }: { list: SelList; at: { id: number; x: number; y: number } | null; onClose: () => void }) {
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
  const marked = hasUnreadMark(chat);
  const lastId = ((chat?.last as { id?: number | null } | null)?.id ?? 0) || (chat?.knownMaxId as number) || 0;
  const pinned = isPinned(chat), archived = isArchived(chat);
  return (
            <MenuPopover
              open={!!at && !!chat} anchor={p ?? undefined}
              label="Действия с чатом"
              onClose={onClose}
              items={[
                { icon: 'newTab', label: 'Открыть в новой вкладке', onClick: () => { onClose(); window.open(location.pathname + '#chat=' + id, '_blank', 'noopener'); } },
                { icon: 'checkCircle', label: 'Выбрать', onClick: () => { onClose(); startChatSelect(list, id); } },
                // порядок — как в Telegram: прочитанное, папка, закрепить, уведомления, архив
                ...(unread || marked
                  ? [{ icon: 'markRead', label: 'Отметить как прочитанное', onClick: () => { onClose(); if (unread && lastId) seen(id, lastId); clearUnreadMark(id); } }]
                  : [{ icon: 'markUnread', label: 'Отметить как непрочитанное', onClick: () => { onClose(); markUnread(id); } }]),
                ...folderItems,
                { icon: pinned ? 'unpin' : 'pin', label: pinned ? 'Открепить' : 'Закрепить', onClick: () => { onClose(); togglePin(id); } },
                { icon: muted ? 'bell' : 'bellOff', label: muted ? 'Включить уведомления' : 'Выключить уведомления', onClick: () => { onClose(); toggleMute(id); } },
                ...(isSystemChat(chat as never) ? [] : [{ icon: archived ? 'unarchive' : 'archive', label: archived ? 'Вернуть из архива' : 'В архив', onClick: () => { onClose(); toggleArchive(id); } }]),
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
            { icon: 'channels', label: 'Новый канал', onClick: () => { setGlobal({ newChannel: null }); pick('newChannel'); } },
            { icon: 'community', label: 'Новая группа', onClick: () => { setGlobal({ newGroup: null }); pick('newGroup'); } },
            { icon: 'contact', label: 'Новое сообщение', onClick: () => pick('contacts') },
          ]} />
      <button ref={btn} type="button" class={'rl-fab-main app-newchat-btn' + (open ? ' app-newchat-open' : '')} aria-label={open ? 'Закрыть' : 'Новый чат'}
        aria-expanded={open} aria-haspopup="menu" onPointerDown={ripple} onClick={() => setOpen(!open)}>
        <Icon name="pencilFilled" size={24} class="app-newchat-pencil" />
        <Icon name="close" size={24} class="app-newchat-close" />
      </button>
    </div>
  );
}
