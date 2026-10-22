import { Avatar, FolderTabs, Icon, LazyImage, LazyRoot, lazyObserve, MediaViewer, peerTone, player, Presence, reducedMotion, SlideStack, useMinVisible, WindowGrid, WindowList } from '@relay/ui';
import { offlineUrlNow } from '../downloads';
import { LinkTile, linkInfo } from './linkTile';
import { avatarPhoto, userPhoto } from '../profilePhoto';
import { senderAvatar } from '../profilePhoto';
import type { Item } from '@relay/sync-engine/src/types';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { focusMessage, openChat, type MediaTab } from '../data';
import { useMedia } from '../mediaTab';
import { animateScroll, gridCorners, tabCounter, tabLabel, tabScrollTarget, tileSrc, videoFrameSrc, type SharedTab } from '../mediaGrid';
import { getGlobal, useGlobal } from '../global';
import { toggleMusic, trackTitle } from '../music';
import { clock, dayLabel, fileSize, lastSeenText } from './format';
import { openUserChat, prepareUserChat } from '../data';
import { pressOpen } from './press';
import { membersWord, useMembers, type Member } from '../members';
import { useCommonGroups, type CommonGroup } from '../commonGroups';
import { wantPeople } from '../people';

// «Общие медиа» в правой панели — как в Telegram: Медиа, Файлы, Ссылки, Музыка, Голосовые.
// Пустые вкладки не показываем (счётчики из подписки движка); каждая вкладка — страницами по 40, новые сверху.

const ORDER: MediaTab[] = ['media', 'file', 'link', 'audio', 'voice'];

export type Att = { id: string; kind: string; mime: string; name: string; size: number; thumb?: string | null; duration?: number | null; w?: number | null; h?: number | null;
  preview?: { name: string; w: number; h: number; size: number } | null };
export type Msg = Item & { id: number; clientId: string; senderId: number; createdAt: string; body: string; attachment?: Att | null; entities?: { type: string; offset: number; length: number; url?: string }[] | null };

export const when = (iso: string) => `${dayLabel(iso)}, ${clock(iso)}`;
export const dur = (s?: number | null) => { s = Math.max(0, Math.round(s ?? 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const fileUrl = (a: Att) => `/files/${a.id}`;
const show = (m: Msg) => focusMessage({ id: m.id, sort: m.id });

/** Цвет плитки по расширению (как в Telegram): таблицы и apk — зелёный, архивы и презентации — оранжевый, pdf — красный. */
export function extTone(ext: string): string {
  if (/^(apk|xls|xlsx|ods|csv)$/.test(ext)) return 'green';
  if (/^(zip|rar|7z|tar|gz|bz2|xz|zst|ppt|pptx|odp)$/.test(ext)) return 'orange';
  if (/^(pdf|xps)$/.test(ext)) return 'red';
  return 'blue';
}

type Tab = SharedTab;

/** group — в группе первая вкладка «Участники» (как в Telegram): панель не бывает пустой.
 *  onHead — вкладки, показанная и их счётчики: шапка панели пишет счётчик, когда вкладки прилипли к верху.
 *  onMember — клик по участнику (без него — переписка с ним поверх текущего чата, через стек). */
export interface MediaHead { tabs: Tab[]; shown: Tab; counters: (string | null)[] }
export function SharedMedia({ chatId, group = false, peerId = null, onHead, onMember }: { chatId: number; group?: boolean; peerId?: number | null; onHead?: (h: MediaHead | null) => void; onMember?: (userId: number) => void }) {
  const [tab, setTab] = useState<Tab | null>(null);
  const members = useMembers(chatId, group);
  // личный чат: группы, где состоите оба (как в Telegram — последней вкладкой)
  const common = useCommonGroups(group ? null : peerId);
  // счётчики приходят с любой подпиской media этого чата и обновляются журналом (новое сообщение — новый счётчик)
  const { counts: known, loading: countsLoading } = useMedia(chatId, 'media', 0);
  // офлайн на холодную: счётчиков нет и не ждём — как раньше, нули (пустое состояние), а не вечная заглушка
  const counts = known ?? (countsLoading ? null : { media: 0, file: 0, link: 0, audio: 0, voice: 0 });
  // клик по вкладке, пока над ней виден профиль: панель за ~300 мс доезжает вкладками до верха, потом переключаем
  // (содержимое не меняется посреди прокрутки); таблетка и шапка — сразу на новой вкладке
  const [pending, setPending] = useState<Tab | null>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<Element | null>(null);
  useLayoutEffect(() => { const r = pages.current?.closest('.rl-aside-body') ?? null; if (r !== root) setRoot(r); });
  const bar = useRef<HTMLDivElement>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => { setTab(null); setPending(null); }, [chatId]);
  useEffect(() => () => cancel.current?.(), [chatId]);
  const tabs: Tab[] = [...(group ? ['members' as const] : []), ...(counts ? ORDER.filter((t) => counts[t] > 0) : []), ...(common?.length ? ['groups' as const] : [])];
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? null;
  const shown = pending && tabs.includes(pending) ? pending : active;
  const counters = tabs.map((t) => tabCounter(t, known, members ? members.members.length : null, common ? common.length : null));
  const headKey = shown ? tabs.join() + '|' + shown + '|' + counters.join() : '';
  useEffect(() => { onHead?.(shown ? { tabs, shown, counters } : null); }, [headKey]);
  const pick = (id: Tab) => {
    cancel.current?.();
    cancel.current = null;
    const el = bar.current, body = el?.closest<HTMLElement>('.rl-aside-body');
    const to = el && body ? tabScrollTarget({ scrollTop: body.scrollTop, offset: el.getBoundingClientRect().top - body.getBoundingClientRect().top, max: body.scrollHeight - body.clientHeight }) : null;
    if (to == null || !body) { setPending(null); setTab(id); return; }
    setPending(id);
    cancel.current = animateScroll(body, to, 300, reducedMotion(), () => { cancel.current = null; setPending(null); setTab(id); });
  };

  if (!counts && !group) return <div class="app-sm-loading" aria-busy="true" />;
  if (!tabs.length) return null;   // медиа нет — как в Telegram: просто профиль, без вкладок и без заглушки
  return (
    <>
      {/* одна непустая вкладка — переключать нечего: вместо одинокой плашки заголовок раздела */}
      {tabs.length > 1 ? (
        <div class="rl-aside-tabs" ref={bar}>
          <FolderTabs label="Общие медиа" active={shown} onChange={pick} items={tabs.map((t) => ({ id: t, label: tabLabel(t) }))} />
        </div>
      ) : <h3 class="app-sm-heading">{tabLabel(tabs[0])}</h3>}
      <div class="rl-aside-pages" ref={pages}>
        {/* ленивые картинки и кадры видео меряют запас от прокрутки панели, а не от окна (её край их обрезает) */}
        <LazyRoot.Provider value={root}>
          <SlideStack variant="tabs" order={tabs} active={active} render={(k: string) => k === 'members' ? <MembersList key={chatId + k} data={members} onOpen={onMember ?? ((id) => void openUserChat(id))} /> : k === 'groups' ? <GroupsList key={chatId + k} groups={common ?? []} /> : <TabList key={chatId + k} chatId={chatId} tab={k as MediaTab} />} />
        </LazyRoot.Provider>
      </div>
    </>
  );
}

/** Список вкладки: первая страница при открытии, следующие — когда низ списка близко. */
function TabList({ chatId, tab }: { chatId: number; tab: MediaTab }) {
  const { items: list0, done, loading, more } = useMedia(chatId, tab);
  const items = list0 as Msg[];
  // следующая страница — когда окно виртуального списка (видимое + запас) дошло до хвоста; страница догрузилась,
  // а окно всё ещё у хвоста — проверка повторяется (nearEnd)
  const nearEnd = done ? undefined : more;
  const nearKey = `${loading}:${done}`;

  // «Медиа»: фото открываются просмотрщиком (листать — по всем фото вкладки), видео — в ленте, где есть плеер
  const [viewer, setViewer] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const people = useGlobal((s) => s.people);
  const meId = useGlobal((s) => s.me?.userId);
  // авторы в просмотрщике (имя и аватарка) — из people
  const senders = [...new Set(items.map((m) => m.senderId as number))].join(',');
  useEffect(() => { if (senders) wantPeople(senders.split(',').map(Number)); }, [senders]);
  // первая страница: кольцо — только если ждём дольше 150 мс (быстрый ответ — без мигания) и не короче 600 мс;
  // потом оно гаснет, а страница проявляется поверх (crossfade). Была в кэше — рисуется сразу, без проявления.
  const waiting = !items.length && loading;
  const ring = useMinVisible(waiting, { delay: 150, min: 600 });
  const [fade] = useState(waiting);
  // следующая страница — маленькое кольцо в хвосте: место под него держится, пока есть что грузить (без скачка)
  const tail = useMinVisible(!!items.length && loading && !done, { delay: 150, min: 500 });
  if (waiting || ring) return (
    <div class="app-sm-loading app-sm-wait" aria-busy="true" aria-label="Загрузка">
      <Presence show={ring} exitMs={200}><Spin /></Presence>
    </div>
  );
  const photos = tab === 'media' ? items.filter((m) => !m.attachment!.mime.startsWith('video/')) : [];
  const open = (m: Msg) => { const k = photos.indexOf(m); if (k >= 0) setViewer(k); else show(m); };
  // длинные вкладки — виртуальные (WindowList ищет прокрутку панели): в DOM только видимые строки и запас;
  // высота списка — все строки сразу, поэтому догрузка в конец не сдвигает прокрутку
  const list = tab === 'media' ? <MediaGrid items={items} onOpen={open} host={grid} onNearEnd={nearEnd} nearKey={nearKey} /> : (
    <div class="app-sm-list">
      <WindowList items={items} rowHeight={tab === 'link' ? LINK_ROW : SM_ROW} overscan={6} getKey={(m: Msg) => m.id} onNearEnd={nearEnd} nearEndKey={nearKey}
        render={(m: Msg) => tab === 'file' ? <FileRow m={m} /> : tab === 'link' ? <LinkRow m={m} /> : <TrackRow m={m} chatId={chatId} items={items} />} />
    </div>
  );
  return <>
    <div class={'app-sm-page' + (fade ? ' app-sm-page-in' : '')}>
      {list}
      {done ? null : (
        <div class="app-sm-more" role="status" aria-label={tail ? 'Загружаем ещё' : undefined}>
          <Presence show={tail} exitMs={200}><Spin /></Presence>
        </div>
      )}
    </div>
    {viewer !== null && photos[viewer] ? (
      <MediaViewer index={viewer}
        items={photos.map((m) => { const a = m.attachment!; return { src: fileUrl(a), thumb: a.thumb, w: a.w, h: a.h, name: a.name, download: fileUrl(a) + '?download=1', caption: m.body,
          date: when(m.createdAt), sender: m.senderId === meId ? 'Вы' : people[m.senderId]?.name ?? '', avatar: senderAvatar(m.senderId) }; })}
        origin={(k: number) => grid.current?.querySelector<HTMLElement>(`[data-mid="${photos[k]?.id}"]`) ?? null}
        onClose={() => setViewer(null)} />
    ) : null}
  </>;
}

/** Кольцо загрузки вкладки (как «Загружаем ещё чаты» в списке чатов): крутится сам svg — на композиторе. */
const Spin = () => (
  <svg class="app-sm-spin" width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 44" /></svg>
);

/** Шаг строки списка вкладки (строка + зазор 4 px под ней): файлы, музыка, голосовые — 60, ссылки — 72 (описание в одну строку). */
const SM_ROW = 64, LINK_ROW = 76;
/** Строка участника — высота строки списка чатов (--size-row). */
const MEMBER_ROW = 72;
/** Ширина сетки с прошлого показа: повторное открытие вкладки рисует строки сразу, без пустого кадра. */
let gridWidth = 0;

/** «Медиа»: квадраты по 3 в ряд через 1 px — виртуальная сетка (WindowGrid): плитки одним слоем, ключ — сообщение,
 *  поэтому новое фото сверху сдвигает плитки, а не пересоздаёт их (картинки не мигают). */
function MediaGrid({ items, onOpen, host, onNearEnd, nearKey }: { items: Msg[]; onOpen: (m: Msg) => void; host: { current: HTMLDivElement | null }; onNearEnd?: () => void; nearKey: string }) {
  const n = items.length;
  return (
    <div class="app-media-vgrid" ref={host}>
      <WindowGrid items={items} cols={3} gap={1} overscan={4} initialWidth={gridWidth} onWidth={(w: number) => { gridWidth = w; }}
        getKey={(m: Msg) => m.id} onNearEnd={onNearEnd} nearEndKey={nearKey}
        render={(m: Msg, i: number) => <MediaCell m={m} onOpen={onOpen} corners={gridCorners(i, n)} />} />
    </div>
  );
}

/** corners — какие углы скруглить (tl tr bl br): в виртуальной сетке :nth-child не знает соседей. */
export function MediaCell({ m, onOpen, corners }: { m: Msg; onOpen: (m: Msg) => void; corners?: string }) {
  const a = m.attachment!;
  const video = a.mime.startsWith('video/');
  // видео без кадра-превью: первый кадр и длительность — из метаданных самого файла (как в Telegram)
  const [len, setLen] = useState(a.duration ?? 0);
  const [frame, setFrame] = useState(false);
  // <video> — только когда плитка подъехала к экрану (общий наблюдатель LazyImage): сотня роликов в сетке
  // не тянет метаданные каждый, пока их не видно
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const bare = video && !a.thumb;
  const root = useContext(LazyRoot);
  useEffect(() => { if (!bare || near || !box.current) return; return lazyObserve(box.current, () => setNear(true), root); }, [bare, root]);
  return (
    <button type="button" class={'app-media-cell' + (corners ? ' ' + corners.split(' ').map((c) => 'is-' + c).join(' ') : '')} data-mid={m.id} aria-label={a.name} onClick={() => onOpen(m)}>
      {!bare ? <LazyImage src={video ? '' : tileSrc(a)} thumb={a.thumb ?? undefined} alt={a.name} /> : (
        <span class="app-media-video" ref={box}>
          {near ? <video class={'app-media-frame' + (frame ? ' app-media-frame-in' : '')} src={videoFrameSrc(a)} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
            onLoadedMetadata={(e) => { const d = (e.currentTarget as HTMLVideoElement).duration; if (!len && !a.preview && Number.isFinite(d)) setLen(d); }}
            onLoadedData={() => setFrame(true)} /> : null}
          <Icon name="play" size={28} />
        </span>
      )}
      {video && len ? <span class="app-media-dur">{dur(len)}</span> : null}
    </button>
  );
}

function FileRow({ m }: { m: Msg }) {
  const a = m.attachment!;
  const ext = (a.name.includes('.') ? a.name.split('.').pop()! : a.mime.split('/')[1] ?? 'file').toLowerCase();
  const download = () => { const el = document.createElement('a'); el.href = fileUrl(a) + '?download=1'; el.download = a.name; el.click(); };
  return (
    <div class="app-sm-row">
      <button type="button" class={'app-sm-ext app-sm-ext-' + extTone(ext)} aria-label={'Скачать ' + a.name} onClick={download}>
        <span class="app-sm-ext-label">{ext.length <= 4 ? ext : ''}</span>
        <span class="app-sm-ext-dl"><Icon name="download" size={22} /></span>
      </button>
      <div class="app-sm-text">
        <b class="app-sm-title" title={a.name}>{a.name}</b>
        <small>{fileSize(a.size)} • <button type="button" class="app-sm-date" onClick={() => show(m)}>{when(m.createdAt)}</button></small>
      </div>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i;

function LinkRow({ m }: { m: Msg }) {
  const ent = m.entities?.find((e) => e.type === 'link' && e.url);
  const raw = ent?.url ?? m.body.match(URL_RE)?.[0] ?? '';
  const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let host = raw;
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* как есть */ }
  // превью страницы (картинка, заголовок, описание) — если загружено; иначе сайт и текст сообщения без ссылки
  const info = linkInfo(m, raw, host);
  return (
    <div class="app-sm-row app-sm-row-link">
      <LinkTile photo={info.photo} host={host} />
      <div class="app-sm-text">
        <button type="button" class="app-sm-title app-sm-plain" onClick={() => show(m)}>{info.title}</button>
        {info.desc ? <button type="button" class="app-sm-desc app-sm-plain" onClick={() => show(m)}>{info.desc}</button> : null}
        <a class="app-sm-url" href={href} target="_blank" rel="noopener noreferrer">{raw}</a>
      </div>
    </div>
  );
}

/** Музыка и голосовые: круглая кнопка 48 px (у кружка — его кадр). Ключ трека — ключ сообщения (как в ленте),
 *  поэтому состояние кнопки общее с лентой и плеером; плейлист / очередь — эта вкладка. */
function TrackRow({ m, chatId, items }: { m: Msg; chatId: number; items: Msg[] }) {
  const a = m.attachment!;
  const key = String(m.clientId);
  const [st, setSt] = useState(() => player.playerState());
  useEffect(() => player.subscribe(setSt), []);
  const playing = st.key === key && st.playing;
  const music = a.kind === 'audio';
  const g = getGlobal(), me = g.me?.userId;
  const chat = g.chats.find((c) => c.id === chatId);
  const title = music ? trackTitle(a.name) : senderTitle(m.senderId, me, chat);
  const voiceTrack = (x: Msg) => ({ key: String(x.clientId), kind: 'voice' as const, src: offlineUrlNow(x.attachment!.id) ?? fileUrl(x.attachment!), duration: x.attachment!.duration ?? 0,
    title: senderTitle(x.senderId, me, chat), subtitle: x.attachment!.kind === 'round' ? 'Видеосообщение' : 'Голосовое сообщение', chatId, msgId: x.id });
  const toggle = () => {
    if (music) { toggleMusic(m as never, items as never, chatId); return; }
    // голосовые: «дальше» — новее (как в Telegram), список вкладки — новые сверху
    player.setQueue((k: string, dir: 1 | -1) => {
      const i = items.findIndex((x) => String(x.clientId) === k);
      const j = i - dir;
      return i >= 0 && items[j] ? voiceTrack(items[j]) : null;
    });
    player.toggle(voiceTrack(m));
  };
  return (
    <div class="app-sm-row">
      <button type="button" class={'app-sm-play' + (a.kind === 'round' && a.thumb ? ' app-sm-play-round' : '')} style={a.kind === 'round' && a.thumb ? { backgroundImage: `url(${a.thumb})` } : undefined}
        aria-label={playing ? 'Пауза' : 'Слушать'} onClick={toggle}>
        <Icon name={playing ? 'pause' : 'play'} size={22} />
      </button>
      <div class="app-sm-text">
        <div class="app-sm-head">
          <b class="app-sm-title">{title}</b>
          {!music ? <button type="button" class="app-sm-date app-sm-right" onClick={() => show(m)}>{short(m.createdAt)}</button> : null}
        </div>
        <small>{dur(a.duration)}{music ? <> • <button type="button" class="app-sm-date" onClick={() => show(m)}>{when(m.createdAt)}</button></> : null}</small>
      </div>
    </div>
  );
}

/** Коротко, как в Telegram: сегодня — время, иначе — дата. */
const short = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : dayLabel(iso));

/** «Вы → Имя чата» за свои, «Отправитель → Группа» в группе, иначе — имя (как в Telegram). */
function senderTitle(senderId: number, me: number | undefined, chat: Item | undefined): string {
  const g = getGlobal();
  const chatTitle = String(chat?.title ?? '');
  const name = senderId === me ? 'Вы' : g.people[senderId]?.name ?? chatTitle;
  if (senderId === me) return `Вы → ${chatTitle}`;
  return chat?.kind === 'group' ? `${name} → ${chatTitle}` : name;
}

/** Участники группы — как в Telegram: аватар, имя, статус (в сети — цветом), «владелец» справа; клик — переписка с ним поверх группы.
 *  Список виртуальный: в большой группе в DOM только видимые строки. */
function MembersList({ data, onOpen }: { data: { ownerId: number | null; members: Member[] } | null; onOpen: (userId: number) => void }) {
  const me = useGlobal((s) => s.me?.userId);
  // у участника без фото в ответе аватарка — из userPhoto: просим его в people
  const bare = data ? data.members.filter((m) => !m.photo).map((m) => m.userId).join(',') : '';
  useEffect(() => { if (bare) wantPeople(bare.split(',').map(Number)); }, [bare]);
  if (!data) return <div class="app-sm-loading" aria-busy="true" />;
  return (
    <div class="app-members">
      <WindowList items={data.members} rowHeight={MEMBER_ROW} overscan={6} role="list" getKey={(m: Member) => m.userId} render={(m: Member) => {
        const self = m.userId === me;
        const status = self ? 'в сети' : lastSeenText(!!m.online, m.lastSeen);
        return (
          <button type="button" role="listitem" class="rl-row app-member" disabled={self} {...pressOpen(() => prepareUserChat(m.userId), () => onOpen(m.userId))}>
            <Avatar name={m.name} tone={peerTone(m.userId)} size={44} online={!!m.online && !self} {...(self ? senderAvatar(m.userId) : avatarPhoto(m.photo ?? userPhoto(m.userId)))} />
            <span class="rl-row-main">
              <span class="app-member-top"><span class="rl-row-name">{self ? m.name + ' (вы)' : m.name}</span>{m.rank || m.userId === data.ownerId || m.role === 'admin' ? <span class="app-member-badge">{m.rank || (m.userId === data.ownerId ? 'владелец' : 'админ')}</span> : null}</span>
              <span class={'rl-row-preview' + (m.online || self ? ' app-online' : '')}>{status}</span>
            </span>
          </button>
        );
      }} />
    </div>
  );
}

/** «Группы»: общие с собеседником — аватар, название, «N участников»; нажатие открывает группу (как в Telegram). */
function GroupsList({ groups }: { groups: CommonGroup[] }) {
  return (
    <div class="app-members">
      <WindowList items={groups} rowHeight={MEMBER_ROW} overscan={6} role="list" getKey={(g: CommonGroup) => g.id} render={(g: CommonGroup) => (
        <button type="button" role="listitem" class="rl-row app-member" onClick={() => openChat(g.id)}>
          <Avatar name={g.title} tone={peerTone(g.id)} size={44} {...avatarPhoto(g.photo)} />
          <span class="rl-row-main">
            <span class="app-member-top"><span class="rl-row-name">{g.title || 'Группа'}</span></span>
            <span class="rl-row-preview">{g.members} {membersWord(g.members)}</span>
          </span>
        </button>
      )} />
    </div>
  );
}
