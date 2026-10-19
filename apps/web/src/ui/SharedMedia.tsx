import { Avatar, EmptyState, FolderTabs, Icon, LazyImage, MediaViewer, peerTone, player, SlideStack } from '@relay/ui';
import { LinkTile, linkInfo } from './linkTile';
import { avatarPhoto, userPhoto } from '../profilePhoto';
import { senderAvatar } from '../profilePhoto';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { chatMedia, chatMediaCounts, focusMessage, type MediaTab } from '../data';
import { getGlobal, useGlobal } from '../global';
import { toggleMusic, trackTitle } from '../music';
import { clock, dayLabel, fileSize, lastSeenText } from './format';
import { startDirectChat } from '../data';
import { useMembers, type Member } from '../members';

// «Общие медиа» в правой панели — как в Telegram: Медиа, Файлы, Ссылки, Музыка, Голосовые.
// Пустые вкладки не показываем (счётчики с сервера); каждая вкладка — страницами по 40, новые сверху.

const ORDER: MediaTab[] = ['media', 'file', 'link', 'audio', 'voice'];
const LABEL: Record<MediaTab, string> = { media: 'Медиа', file: 'Файлы', link: 'Ссылки', audio: 'Музыка', voice: 'Голосовые' };

export type Att = { id: string; kind: string; mime: string; name: string; size: number; thumb?: string | null; duration?: number | null; w?: number | null; h?: number | null };
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

type Tab = MediaTab | 'members';

/** group — в группе первая вкладка «Участники» (как в Telegram): панель не бывает пустой. */
export function SharedMedia({ chatId, group = false }: { chatId: number; group?: boolean }) {
  const [counts, setCounts] = useState<Record<MediaTab, number> | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const members = useMembers(chatId, group, useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.membersRev as number) ?? 0));
  // счётчики — при открытии и когда в чате появилось новое сообщение
  const lastId = useGlobal((s) => ((s.chats.find((c) => c.id === chatId)?.last as { id?: number } | null)?.id ?? 0));
  useEffect(() => {
    let live = true;
    chatMediaCounts(chatId).then((c) => { if (live) setCounts(c); }).catch(() => { if (live) setCounts((x) => x ?? { media: 0, file: 0, link: 0, audio: 0, voice: 0 }); });
    return () => { live = false; };
  }, [chatId, lastId]);
  useEffect(() => { setTab(null); }, [chatId]);
  const tabs: Tab[] = [...(group ? ['members' as const] : []), ...(counts ? ORDER.filter((t) => counts[t] > 0) : [])];
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? null;

  if (!counts && !group) return <div class="app-sm-loading" aria-busy="true" />;
  if (!tabs.length) return (
    <div class="rl-aside-pages app-sm-empty">
      <EmptyState kind="media" title="Здесь пока пусто" text="Фото, файлы, ссылки, музыка и голосовые из этого чата появятся здесь." />
    </div>
  );
  return (
    <>
      {/* одна непустая вкладка — переключать нечего: вместо одинокой плашки заголовок раздела */}
      {tabs.length > 1 ? (
        <div class="rl-aside-tabs">
          <FolderTabs label="Общие медиа" active={active} onChange={(id: Tab) => setTab(id)} items={tabs.map((t) => ({ id: t, label: t === 'members' ? 'Участники' : LABEL[t] }))} />
        </div>
      ) : <h3 class="app-sm-heading">{tabs[0] === 'members' ? 'Участники' : LABEL[tabs[0]]}</h3>}
      <div class="rl-aside-pages">
        <SlideStack variant="tabs" order={tabs} active={active} render={(k: string) => k === 'members' ? <MembersList key={chatId + k} data={members} /> : <TabList key={chatId + k} chatId={chatId} tab={k as MediaTab} />} />
      </div>
    </>
  );
}

/** Список вкладки: первая страница при открытии, следующие — когда низ списка близко. */
function TabList({ chatId, tab }: { chatId: number; tab: MediaTab }) {
  const [items, setItems] = useState<Msg[] | null>(null);
  const [more, setMore] = useState(false);
  const busy = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const load = (before?: number) => {
    if (busy.current) return;
    busy.current = true;
    chatMedia(chatId, tab, before).then((r) => {
      setItems((cur) => [...(before ? cur ?? [] : []), ...(r.messages as Msg[])]);
      setMore(r.hasMore);
    }).catch(() => setItems((cur) => cur ?? [])).finally(() => { busy.current = false; });
  };
  useEffect(() => { load(); }, [chatId, tab]);
  useEffect(() => {
    const el = end.current;
    if (!el || !more || !items?.length) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) load(items[items.length - 1].id); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, items]);

  // «Медиа»: фото открываются просмотрщиком (листать — по всем фото вкладки), видео — в ленте, где есть плеер
  const [viewer, setViewer] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const names = useGlobal((s) => s.names);
  const meId = useGlobal((s) => s.me?.userId);
  if (!items) return <div class="app-sm-loading" aria-busy="true" />;
  const photos = tab === 'media' ? items.filter((m) => !m.attachment!.mime.startsWith('video/')) : [];
  const open = (m: Msg) => { const k = photos.indexOf(m); if (k >= 0) setViewer(k); else show(m); };
  const list = tab === 'media' ? (
    <div class="app-media-grid" ref={grid}>{items.map((m) => <MediaCell key={m.id} m={m} onOpen={open} />)}</div>
  ) : (
    <div class="app-sm-list">
      {items.map((m) => tab === 'file' ? <FileRow key={m.id} m={m} /> : tab === 'link' ? <LinkRow key={m.id} m={m} /> : <TrackRow key={m.id} m={m} chatId={chatId} items={items} />)}
    </div>
  );
  return <>{list}{more ? <div ref={end} class="app-sm-more" /> : null}
    {viewer !== null && photos[viewer] ? (
      <MediaViewer index={viewer}
        items={photos.map((m) => { const a = m.attachment!; return { src: fileUrl(a), thumb: a.thumb, w: a.w, h: a.h, name: a.name, download: fileUrl(a) + '?download=1', caption: m.body,
          date: when(m.createdAt), sender: m.senderId === meId ? 'Вы' : names[m.senderId] ?? '', avatar: senderAvatar(m.senderId) }; })}
        origin={(k: number) => grid.current?.querySelector<HTMLElement>(`[data-mid="${photos[k]?.id}"]`) ?? null}
        onClose={() => setViewer(null)} />
    ) : null}
  </>;
}

export function MediaCell({ m, onOpen }: { m: Msg; onOpen: (m: Msg) => void }) {
  const a = m.attachment!;
  const video = a.mime.startsWith('video/');
  // видео без кадра-превью: первый кадр и длительность — из метаданных самого файла (как в Telegram)
  const [len, setLen] = useState(a.duration ?? 0);
  const [frame, setFrame] = useState(false);
  return (
    <button type="button" class="app-media-cell" data-mid={m.id} aria-label={a.name} onClick={() => onOpen(m)}>
      {a.thumb || !video ? <LazyImage src={video ? '' : fileUrl(a)} thumb={a.thumb ?? undefined} alt={a.name} /> : (
        <span class="app-media-video">
          <video class={'app-media-frame' + (frame ? ' app-media-frame-in' : '')} src={fileUrl(a) + '#t=0.1'} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
            onLoadedMetadata={(e) => { const d = (e.currentTarget as HTMLVideoElement).duration; if (!len && Number.isFinite(d)) setLen(d); }}
            onLoadedData={() => setFrame(true)} />
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
    <div class="app-sm-row">
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
  const voiceTrack = (x: Msg) => ({ key: String(x.clientId), kind: 'voice' as const, src: fileUrl(x.attachment!), duration: x.attachment!.duration ?? 0,
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
  const name = senderId === me ? 'Вы' : g.names[senderId] ?? chatTitle;
  if (senderId === me) return `Вы → ${chatTitle}`;
  return chat?.kind === 'group' ? `${name} → ${chatTitle}` : name;
}

/** Участники группы — как в Telegram: аватар, имя, статус (в сети — цветом), «владелец» справа; клик — личный чат. */
function MembersList({ data }: { data: { ownerId: number | null; members: Member[] } | null }) {
  const me = useGlobal((s) => s.me?.userId);
  if (!data) return <div class="app-sm-loading" aria-busy="true" />;
  return (
    <div class="app-members" role="list" aria-label="Участники">
      {data.members.map((m) => {
        const self = m.userId === me;
        const status = self ? 'в сети' : lastSeenText(!!m.online, m.lastSeen);
        return (
          <button key={m.userId} type="button" role="listitem" class="rl-row app-member" disabled={self} onClick={() => void startDirectChat(m.userId)}>
            <Avatar name={m.name} tone={peerTone(m.userId)} size={44} online={!!m.online && !self} {...(self ? senderAvatar(m.userId) : avatarPhoto(m.photo ?? userPhoto(m.userId)))} />
            <span class="rl-row-main">
              <span class="app-member-top"><span class="rl-row-name">{self ? m.name + ' (вы)' : m.name}</span>{m.rank || m.userId === data.ownerId || m.role === 'admin' ? <span class="app-member-badge">{m.rank || (m.userId === data.ownerId ? 'владелец' : 'админ')}</span> : null}</span>
              <span class={'rl-row-preview' + (m.online || self ? ' app-online' : '')}>{status}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
