import type { MediaTab, ProfilePhoto } from '@relay/protocol';
import { LinkTile, linkInfo } from '../linkTile';
import { senderAvatar } from '../../profilePhoto';
import { Avatar, EmptyState, FolderTabs, Highlight, Icon, MediaViewer, peerTone, player, SlideStack, TrackSeek } from '@relay/ui';
import type { Item, SearchHit, SearchResult } from '@relay/sync-engine/src/types';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { openChat, searchMessages } from '../../data';
import { wantPeople } from '../../people';
import { getGlobal, useGlobal, type Person } from '../../global';
import { toggleMusic, trackTitle } from '../../music';
import { avatarPhoto } from '../../profilePhoto';
import {
  addRecent, clearRecent, closeSearch, getRecent, monthKey, monthLabel, SEARCH_TABS, searchGlobalMedia, searchPeople, setSearchTab,
  subscribeRecent, topChats, type MediaHit, type PersonHit, type SearchTab,
} from '../../search';
import { chatTime, chatTone, fileSize, isSystemChat, shownBody, snippet } from '../format';
import { attachmentHit } from '../../searchHit';
import { dur, extTone, fileUrl, MediaCell, type Msg, when } from '../SharedMedia';

// Глобальный поиск — содержимое левой колонки в режиме поиска (как в Telegram Web): вкладки сверху,
// «Чаты» (недавние и частые без запроса; чаты, люди и сообщения с запросом) и вкладки медиа по всем чатам.

const LOCAL_SHOWN = 5;   // строк в секции до «Показать все»

export function GlobalSearch() {
  const tab = useGlobal((s) => s.searchTab) as SearchTab;
  const q = useGlobal((s) => s.search).trim();
  const order = SEARCH_TABS.map((t) => t.id);
  // Esc — выход из поиска, где бы ни был фокус (вкладки, строки); открытое поверх (просмотр, меню) закрывается первым
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.rl-viewer, .rl-modal-layer .rl-mdl-dialog')) { e.preventDefault(); closeSearch(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="app-gsearch">
      <div class="app-gsearch-tabs">
        <FolderTabs label="Разделы поиска" active={tab} onChange={(id: SearchTab) => setSearchTab(id)} items={SEARCH_TABS} />
      </div>
      <div class="app-gsearch-pages">
        <SlideStack variant="tabs" order={order} active={tab} render={(k: string) => (k === 'chats' ? <ChatsTab q={q} /> : <MediaTab key={k} kind={k as MediaTab} q={q} />)} />
      </div>
    </div>
  );
}

/** Открыть чат из поиска: в недавние, поиск закрыть (как в Telegram на компьютере). */
function pickChat(chatId: number): void {
  addRecent(chatId);
  openChat(chatId);
  setTimeout(closeSearch, 0);
}
/** Перейти к сообщению: поиск остаётся открытым — можно листать выдачу дальше. */
const showMessage = (chatId: number, id: number) => openChat(chatId, { id, sort: id });

function useRecent(): number[] {
  const [r, setR] = useState(getRecent);
  useEffect(() => subscribeRecent(() => setR(getRecent())), []);
  return r;
}

const chatPhoto = (c: Item) => avatarPhoto(c.photo as ProfilePhoto | null);

// ---------- «Чаты» ----------

function ChatsTab({ q }: { q: string }) {
  return <div class="app-gsearch-scroll">{q ? <ChatResults q={q} /> : <RecentChats />}</div>;
}

/** Без запроса: частые собеседники полосой и «Недавние» с крестиком «очистить». */
function RecentChats() {
  const chats = useGlobal((s) => s.chats);
  const recent = useRecent();
  const [top, setTop] = useState<number[] | null>(null);
  useEffect(() => { let live = true; void topChats().then((ids) => { if (live) setTop(ids); }); return () => { live = false; }; }, []);
  const byId = useMemo(() => new Map(chats.map((c) => [c.id as number, c])), [chats]);
  const topChatsList = (top ?? []).map((id) => byId.get(id)).filter((c): c is Item => !!c);
  const recentList = recent.map((id) => byId.get(id)).filter((c): c is Item => !!c);
  if (!topChatsList.length && !recentList.length) {
    return top === null ? null : <EmptyState kind="search" title="Поиск" text="Ищите чаты, людей, сообщения, фото, файлы, ссылки и музыку." />;
  }
  return (
    <>
      {topChatsList.length ? (
        <div class="app-gsearch-top" role="list" aria-label="Частые собеседники">
          {topChatsList.map((c) => (
            <button key={c.id} type="button" role="listitem" class="app-gsearch-top-item" onClick={() => pickChat(c.id as number)}>
              <Avatar name={String(c.title ?? '')} tone={chatTone(c)} size={54} logo={isSystemChat(c)} {...chatPhoto(c)} />
              <span>{String(c.title ?? '').split(' ')[0]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {recentList.length ? (
        <Section title="Недавние" action={<button type="button" class="app-gsearch-clear" aria-label="Очистить недавние" onClick={clearRecent}><Icon name="close" size={20} /></button>}>
          {recentList.map((c) => <ChatResult key={c.id} c={c} />)}
        </Section>
      ) : null}
    </>
  );
}

function Section({ title, action, children }: { title: ComponentChildren; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="app-gsearch-sect">
      <div class="app-gsearch-sect-head"><span>{title}</span>{action}</div>
      {children}
    </section>
  );
}

function ChatResult({ c, q }: { c: Item; q?: string }) {
  const name = String(c.title ?? 'Чат');
  const sub = c.kind === 'group' ? 'группа' : isSystemChat(c) ? 'служебные уведомления' : '';
  return (
    <button type="button" class="rl-row app-gsearch-row" onClick={() => pickChat(c.id as number)}>
      <Avatar name={name} tone={chatTone(c)} size={48} logo={isSystemChat(c)} {...chatPhoto(c)} />
      <span class="rl-row-main">
        <span class="rl-row-name">{q ? <Highlight text={name} query={q} /> : name}</span>
        {sub ? <span class="rl-row-preview">{sub}</span> : null}
      </span>
    </button>
  );
}

/** С запросом: «Чаты и контакты» (на устройстве) → «Глобальный поиск» (люди с сервера) → «Сообщения». */
function ChatResults({ q }: { q: string }) {
  const chats = useGlobal((s) => s.chats);
  const contacts = useGlobal((s) => s.contacts);
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [q]);
  const needle = q.toLowerCase();
  const local = useMemo(() => {
    const found = chats.filter((c) => String(c.title ?? '').toLowerCase().includes(needle));
    // контакты без открытого чата — тоже сюда (личный чат откроется при клике)
    const withChat = new Set(found.map((c) => c.peerId as number | null).filter(Boolean));
    const extra = contacts.filter((x) => !withChat.has(x.userId as number) && String(x.name ?? '').toLowerCase().includes(needle));
    return { chats: found, contacts: extra };
  }, [chats, contacts, needle]);
  const people = usePeople(q);
  const shownIds = new Set(local.chats.map((c) => c.peerId as number | null).filter(Boolean));
  for (const x of local.contacts) shownIds.add(x.userId as number);
  const global = (people ?? []).filter((p) => !shownIds.has(p.id));
  const localCount = local.chats.length + local.contacts.length;
  const localRows = [
    ...local.chats.map((c) => <ChatResult key={'c' + c.id} c={c} q={q} />),
    ...local.contacts.map((x) => <PersonRow key={'u' + x.userId} p={{ id: x.userId as number, name: String(x.name ?? ''), username: (x.user as { username?: string } | undefined)?.username ?? null, photo: ((x.user as { photo?: ProfilePhoto } | undefined)?.photo) ?? null, chatId: null }} q={q} />),
  ];
  return (
    <>
      {localCount ? (
        <Section title="Чаты и контакты" action={localCount > LOCAL_SHOWN ? <button type="button" class="app-gsearch-more" onClick={() => setAll((v) => !v)}>{all ? 'Свернуть' : 'Показать все'}</button> : null}>
          {all ? localRows : localRows.slice(0, LOCAL_SHOWN)}
        </Section>
      ) : null}
      {global.length ? (
        <Section title="Глобальный поиск">{global.slice(0, 10).map((p) => <PersonRow key={p.id} p={p} q={q} />)}</Section>
      ) : null}
      <MessageResults q={q} empty={!localCount && !global.length && people !== null} />
    </>
  );
}

/** Люди с сервера: троттлинг 300 мс, ответ на устаревший запрос отбрасываем. */
function usePeople(q: string): PersonHit[] | null {
  const [res, setRes] = useState<{ q: string; list: PersonHit[] } | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { void searchPeople(q).then((list) => { if (live) setRes({ q, list }); }, () => { if (live) setRes({ q, list: [] }); }); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return res && res.q === q ? res.list : null;
}

function PersonRow({ p, q }: { p: PersonHit; q: string }) {
  const open = () => {
    if (p.chatId) { pickChat(p.chatId); return; }
    void import('../../data').then((d) => d.startDirectChat(p.id)).then(() => closeSearch());
  };
  return (
    <button type="button" class="rl-row app-gsearch-row" onClick={open}>
      <Avatar name={p.name} tone={peerTone(p.id)} size={48} {...avatarPhoto(p.photo)} />
      <span class="rl-row-main">
        <span class="rl-row-name"><Highlight text={p.name} query={q} /></span>
        {p.username ? <span class="rl-row-preview">@<Highlight text={p.username} query={q.replace(/^@/, '')} /></span> : null}
      </span>
    </button>
  );
}

/** «Сообщения» по всем чатам: страницами, следующая — когда низ близко. */
function MessageResults({ q, empty }: { q: string; empty: boolean }) {
  const [state, setState] = useState<{ q: string; list: SearchHit[]; more: boolean; source: string; early?: true } | null>(null);
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const people = useGlobal((s) => s.people);
  const meId = useGlobal((s) => s.me?.userId);
  const load = (before?: number) => {
    if (busy.current) return;
    busy.current = true;
    // первая страница: найденное на устройстве — сразу, без отметки «на устройстве» (полный ответ его заменит); пусто — ждём полного, без «Ничего не найдено»
    const early = before ? undefined : (r: SearchResult) => {
      if (!r.hits.length || getGlobal().search.trim() !== q) return;   // запрос уже сменили — не затираем новый ответ
      setState((cur) => (cur?.q === q && !cur.early ? cur : { q, list: r.hits, more: false, source: 'server', early: true }));
      wantPeople(r.hits.map((h) => h.senderId));
    };
    searchMessages(q, undefined, before, early).then((r) => {
      setState((cur) => ({ q, list: [...(before && cur?.q === q ? cur.list : []), ...r.hits], more: r.hasMore, source: r.source }));
      wantPeople(r.hits.map((h) => h.senderId));
    }).catch(() => setState((cur) => cur ?? { q, list: [], more: false, source: 'server' })).finally(() => { busy.current = false; });
  };
  useEffect(() => {
    if (q.length < 2) { setState(null); return; }
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const el = end.current;
    if (!el || !state?.more || state.q !== q) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) load(state.list[state.list.length - 1].id); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [state, q]);
  const list = state && state.q === q ? state.list : null;
  if (!list) return null;
  if (!list.length) return empty ? <EmptyState kind="search" title="Ничего не найдено" text="Попробуйте другой запрос." /> : null;
  const chats = getGlobal().chats;
  return (
    <Section title={'Сообщения' + (state!.source === 'local' ? ' · на устройстве' : '')}>
      {list.map((h) => {
        const chat = chats.find((c) => c.id === h.chatId);
        const title = h.chatTitle ?? String(chat?.title ?? 'Чат');
        const who = h.senderId === meId ? 'Вы' : chat?.kind === 'group' ? (people[h.senderId]?.name ?? '').split(' ')[0] : '';
        return (
          <button key={h.chatId + ':' + h.id} type="button" class="rl-row app-gsearch-row app-gsearch-msg" onClick={() => showMessage(h.chatId, h.id)}>
            <Avatar name={title} tone={chat ? chatTone(chat) : peerTone(h.chatId)} size={48} logo={chat ? isSystemChat(chat) : false} {...(chat ? chatPhoto(chat) : {})} />
            <span class="rl-row-main">
              <span class="app-gsearch-line"><span class="rl-row-name">{title}</span><span class="rl-row-time">{chatTime(h.createdAt)}</span></span>
              <span class="rl-row-preview">{who ? <span class="rl-row-author">{who}: </span> : null}<Highlight text={attachmentHit(shownBody(h), h.attachment, q) ?? snippet(shownBody(h), q)} query={q} /></span>
            </span>
          </button>
        );
      })}
      {state!.more ? <div ref={end} class="app-sm-more" /> : null}
    </Section>
  );
}

// ---------- Медиа, ссылки, файлы, музыка, голосовые — по всем чатам ----------

const EMPTY_TEXT: Record<MediaTab, string> = {
  media: 'Фото и видео из всех чатов появятся здесь.', link: 'Ссылки из всех чатов появятся здесь.', file: 'Файлы из всех чатов появятся здесь.',
  audio: 'Музыка из всех чатов появится здесь.', voice: 'Голосовые и видеосообщения из всех чатов появятся здесь.',
};

type Hit = MediaHit & { message: MediaHit['message'] & Msg };

function MediaTab({ kind, q }: { kind: MediaTab; q: string }) {
  const [state, setState] = useState<{ q: string; hits: Hit[]; more: boolean; next?: number } | null>(null);
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const load = (before?: number) => {
    if (busy.current && before) return;
    busy.current = true;
    const query = q;
    searchGlobalMedia(kind, query, before).then((r) => {
      if (getGlobal().search.trim() !== query) return;   // запрос уже сменили — ответ устарел
      setState((cur) => ({ q: query, hits: [...(before && cur?.q === query ? cur.hits : []), ...(r.hits as Hit[])], more: r.hasMore, next: r.next }));
      wantPeople(r.hits.map((h) => h.message.senderId));
    }).catch(() => setState((cur) => cur ?? { q: query, hits: [], more: false })).finally(() => { busy.current = false; });
  };
  useEffect(() => { const t = setTimeout(() => load(), q ? 300 : 0); return () => clearTimeout(t); }, [kind, q]);
  useEffect(() => {
    const el = end.current;
    if (!el || !state?.more) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) load(state.next ?? state.hits[state.hits.length - 1].message.id); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [state]);
  const [viewer, setViewer] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const people = useGlobal((s) => s.people);
  const meId = useGlobal((s) => s.me?.userId);

  if (!state || state.q !== q) return <div class="app-gsearch-scroll"><div class="app-sm-loading" aria-busy="true" /></div>;
  if (!state.hits.length) return <div class="app-gsearch-scroll"><EmptyState kind={q ? 'search' : 'media'} title={q ? 'Ничего не найдено' : 'Здесь пока пусто'} text={q ? 'Попробуйте другой запрос.' : EMPTY_TEXT[kind]} /></div>;

  const who = (h: Hit) => senderLine(h, meId, people);
  if (kind === 'media') {
    const photos = state.hits.filter((h) => !h.message.attachment!.mime.startsWith('video/'));
    const open = (m: Msg) => {
      const k = photos.findIndex((h) => h.message.id === m.id && h.message.chatId === m.chatId);
      if (k >= 0) setViewer(k); else showMessage(m.chatId as number, m.id);
    };
    return (
      <div class="app-gsearch-scroll">
        <div class="app-media-grid app-gsearch-grid" ref={grid}>{state.hits.map((h) => <MediaCell key={h.message.chatId + ':' + h.message.id} m={h.message} onOpen={open} />)}</div>
        {state.more ? <div ref={end} class="app-sm-more" /> : null}
        {viewer !== null && photos[viewer] ? (
          <MediaViewer index={viewer}
            items={photos.map((h) => { const a = h.message.attachment!; return { src: fileUrl(a), thumb: a.thumb, w: a.w, h: a.h, name: a.name, download: fileUrl(a) + '?download=1', caption: h.message.body, date: when(h.message.createdAt), sender: who(h), avatar: senderAvatar(h.message.senderId) }; })}
            origin={(k: number) => grid.current?.querySelector<HTMLElement>(`[data-mid="${photos[k]?.message.id}"]`) ?? null}
            onClose={() => setViewer(null)} />
        ) : null}
      </div>
    );
  }
  // списки: заголовок месяца, когда месяц сменился
  const rows: ComponentChildren[] = [];
  let month = '';
  for (const h of state.hits) {
    const mk = monthKey(h.message.createdAt);
    if (mk !== month) { month = mk; rows.push(<div key={'m' + mk} class="app-gsearch-month">{monthLabel(h.message.createdAt)}</div>); }
    const key = h.message.chatId + ':' + h.message.id;
    rows.push(kind === 'file' ? <FileHit key={key} h={h} who={who(h)} />
      : kind === 'link' ? <LinkHit key={key} h={h} who={who(h)} />
      : <TrackHit key={key} h={h} who={who(h)} hits={state.hits} music={kind === 'audio'} />);
  }
  return (
    <div class="app-gsearch-scroll">
      <div class="app-sm-list app-gsearch-list">{rows}</div>
      {state.more ? <div ref={end} class="app-sm-more" /> : null}
    </div>
  );
}

/** «Вы → чат» за свои, «Отправитель → группа» в группах, имя собеседника в личных (как в Telegram). */
function senderLine(h: Hit, meId: number | undefined, people: Record<number, Person>): string {
  const chat = h.chatTitle ?? 'Чат';
  if (h.message.senderId === meId) return `Вы → ${chat}`;
  return h.chatKind === 'group' ? `${people[h.message.senderId]?.name ?? '…'} → ${chat}` : chat;
}

function FileHit({ h, who }: { h: Hit; who: string }) {
  const m = h.message, a = m.attachment!;
  const ext = (a.name.includes('.') ? a.name.split('.').pop()! : a.mime.split('/')[1] ?? 'file').toLowerCase();
  const image = a.mime.startsWith('image/') && a.thumb;
  const download = () => { const el = document.createElement('a'); el.href = fileUrl(a) + '?download=1'; el.download = a.name; el.click(); };
  return (
    <div class="app-sm-row app-gsearch-hit">
      <button type="button" class={'app-sm-ext app-sm-ext-' + extTone(ext) + (image ? ' app-gsearch-thumb' : '')} style={image ? { backgroundImage: a.id ? `url(${fileUrl(a)}), url(${a.thumb})` : `url(${a.thumb})` } : undefined} aria-label={'Скачать ' + a.name} onClick={download}>
        {image ? null : <span class="app-sm-ext-label">{ext.length <= 4 ? ext : ''}</span>}
        <span class="app-sm-ext-dl"><Icon name="download" size={22} /></span>
      </button>
      <button type="button" class="app-sm-text app-sm-plain" onClick={() => showMessage(m.chatId as number, m.id)}>
        <span class="app-gsearch-line"><b class="app-sm-title" title={a.name}>{a.name}</b><span class="app-gsearch-date">{chatTime(m.createdAt)}</span></span>
        <small class="app-gsearch-sub">{fileSize(a.size)} • {who}</small>
      </button>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i;

function LinkHit({ h, who }: { h: Hit; who: string }) {
  const m = h.message;
  const ent = m.entities?.find((e) => e.type === 'link' && e.url);
  const raw = ent?.url ?? m.body.match(URL_RE)?.[0] ?? '';
  const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let host = raw;
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* как есть */ }
  const info = linkInfo(m, raw, host);
  return (
    <div class="app-sm-row app-gsearch-hit">
      <LinkTile photo={info.photo} host={host} />
      <div class="app-sm-text">
        <span class="app-gsearch-line"><button type="button" class="app-sm-title app-sm-plain" onClick={() => showMessage(m.chatId as number, m.id)}>{info.title}</button><span class="app-gsearch-date">{chatTime(m.createdAt)}</span></span>
        {info.desc ? <button type="button" class="app-sm-desc app-sm-plain" onClick={() => showMessage(m.chatId as number, m.id)}>{info.desc}</button> : null}
        <a class="app-sm-url" href={href} target="_blank" rel="noopener noreferrer">{raw}</a>
        <small class="app-gsearch-sub">{who}</small>
      </div>
    </div>
  );
}

/** Музыка (обложка/кнопка, название, исполнитель) и голосовые (аватар отправителя или кадр кружка). */
function TrackHit({ h, who, hits, music }: { h: Hit; who: string; hits: Hit[]; music: boolean }) {
  const m = h.message, a = m.attachment!;
  // ключ трека — как его ставит плеер: у музыки musicTrack (ключ сообщения), у голосовых — clientId
  const key = music ? String((m as { key?: string }).key ?? m.clientId) : String(m.clientId);
  const [st, setSt] = useState(() => player.playerState());
  useEffect(() => player.subscribe(setSt), []);
  const mine = st.key === key;   // текущий трек плеера — вместо подписи полоса перемотки (как в Telegram)
  const playing = mine && st.playing;
  const people = getGlobal().people, meId = getGlobal().me?.userId;
  const senderName = m.senderId === meId ? (getGlobal().me?.name ?? 'Вы') : people[m.senderId]?.name ?? h.chatTitle ?? '';
  const voiceTrack = (x: Hit) => ({ key: String(x.message.clientId), kind: 'voice' as const, src: fileUrl(x.message.attachment!), duration: x.message.attachment!.duration ?? 0,
    title: senderLine(x, meId, people), subtitle: x.message.attachment!.kind === 'round' ? 'Видеосообщение' : 'Голосовое сообщение', chatId: x.message.chatId as number, msgId: x.message.id });
  const toggle = () => {
    if (music) { toggleMusic(m as never, hits.map((x) => x.message) as never, m.chatId as number); return; }
    player.setQueue((k: string, dir: 1 | -1) => {
      const i = hits.findIndex((x) => String(x.message.clientId) === k);
      const j = i - dir;
      return i >= 0 && hits[j] ? voiceTrack(hits[j]) : null;
    });
    player.toggle(voiceTrack(h));
  };
  const round = (a.kind === 'round' || a.kind === 'audio') && a.thumb;   // кадр кружка или обложка трека
  return (
    <div class="app-sm-row app-gsearch-hit">
      {music || round ? (
        <button type="button" class={'app-sm-play' + (round ? ' app-sm-play-round' : '')} style={round ? { backgroundImage: `url(${a.thumb})` } : undefined} aria-label={playing ? 'Пауза' : 'Слушать'} onClick={toggle}>
          <Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
      ) : (
        <button type="button" class="app-gsearch-voice" aria-label={playing ? 'Пауза' : 'Слушать'} onClick={toggle}>
          <Avatar name={senderName} tone={peerTone(m.senderId)} size={48} {...senderAvatar(m.senderId)} />
          <span class="app-gsearch-voice-icon"><Icon name={playing ? 'pause' : 'play'} size={20} /></span>
        </button>
      )}
      <button type="button" class="app-sm-text app-sm-plain" onClick={() => showMessage(m.chatId as number, m.id)}>
        <span class="app-gsearch-line"><b class="app-sm-title">{music ? ((a as { title?: string }).title || trackTitle(a.name)) : who}</b><span class="app-gsearch-date">{chatTime(m.createdAt)}</span></span>
        {mine ? <TrackSeek class="app-sm-seek" trackKey={key} />
          : <small class="app-gsearch-sub">{dur(a.duration)}{music && (a as { performer?: string }).performer ? <> • {(a as { performer?: string }).performer}</> : null}{music ? <> • {who}</> : null}</small>}
      </button>
    </div>
  );
}
