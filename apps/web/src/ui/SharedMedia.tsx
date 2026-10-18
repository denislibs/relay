import { EmptyState, FolderTabs, Icon, LazyImage, player, SlideStack } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { chatMedia, chatMediaCounts, focusMessage, type MediaTab } from '../data';
import { getGlobal, useGlobal } from '../global';
import { toggleMusic, trackTitle } from '../music';
import { clock, dayLabel, fileSize } from './format';

// «Общие медиа» в правой панели — как в Telegram: Медиа, Файлы, Ссылки, Музыка, Голосовые.
// Пустые вкладки не показываем (счётчики с сервера); каждая вкладка — страницами по 40, новые сверху.

const ORDER: MediaTab[] = ['media', 'file', 'link', 'audio', 'voice'];
const LABEL: Record<MediaTab, string> = { media: 'Медиа', file: 'Файлы', link: 'Ссылки', audio: 'Музыка', voice: 'Голосовые' };

type Att = { id: string; kind: string; mime: string; name: string; size: number; thumb?: string | null; duration?: number | null };
type Msg = Item & { id: number; clientId: string; senderId: number; createdAt: string; body: string; attachment?: Att | null; entities?: { type: string; offset: number; length: number; url?: string }[] | null };

const when = (iso: string) => `${dayLabel(iso)}, ${clock(iso)}`;
const dur = (s?: number | null) => { s = Math.max(0, Math.round(s ?? 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fileUrl = (a: Att) => `/files/${a.id}`;
const show = (m: Msg) => focusMessage({ id: m.id, sort: m.id });

/** Цвет плитки по расширению (как в Telegram): таблицы и apk — зелёный, архивы и презентации — оранжевый, pdf — красный. */
function extTone(ext: string): string {
  if (/^(apk|xls|xlsx|ods|csv)$/.test(ext)) return 'green';
  if (/^(zip|rar|7z|tar|gz|bz2|xz|zst|ppt|pptx|odp)$/.test(ext)) return 'orange';
  if (/^(pdf|xps)$/.test(ext)) return 'red';
  return 'blue';
}

export function SharedMedia({ chatId }: { chatId: number }) {
  const [counts, setCounts] = useState<Record<MediaTab, number> | null>(null);
  const [tab, setTab] = useState<MediaTab | null>(null);
  // счётчики — при открытии и когда в чате появилось новое сообщение
  const lastId = useGlobal((s) => ((s.chats.find((c) => c.id === chatId)?.last as { id?: number } | null)?.id ?? 0));
  useEffect(() => {
    let live = true;
    chatMediaCounts(chatId).then((c) => { if (live) setCounts(c); }).catch(() => { if (live) setCounts((x) => x ?? { media: 0, file: 0, link: 0, audio: 0, voice: 0 }); });
    return () => { live = false; };
  }, [chatId, lastId]);
  useEffect(() => { setTab(null); }, [chatId]);
  const tabs = counts ? ORDER.filter((t) => counts[t] > 0) : [];
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? null;

  if (!counts) return <div class="app-sm-loading" aria-busy="true" />;
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
          <FolderTabs label="Общие медиа" active={active} onChange={(id: MediaTab) => setTab(id)} items={tabs.map((t) => ({ id: t, label: LABEL[t] }))} />
        </div>
      ) : <h3 class="app-sm-heading">{LABEL[tabs[0]]}</h3>}
      <div class="rl-aside-pages">
        <SlideStack variant="tabs" order={tabs} active={active} render={(k: string) => <TabList key={chatId + k} chatId={chatId} tab={k as MediaTab} />} />
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

  if (!items) return <div class="app-sm-loading" aria-busy="true" />;
  const list = tab === 'media' ? (
    <div class="app-media-grid">{items.map((m) => <MediaCell key={m.id} m={m} />)}</div>
  ) : (
    <div class="app-sm-list">
      {items.map((m) => tab === 'file' ? <FileRow key={m.id} m={m} /> : tab === 'link' ? <LinkRow key={m.id} m={m} /> : <TrackRow key={m.id} m={m} chatId={chatId} items={items} />)}
    </div>
  );
  return <>{list}{more ? <div ref={end} class="app-sm-more" /> : null}</>;
}

function MediaCell({ m }: { m: Msg }) {
  const a = m.attachment!;
  const video = a.mime.startsWith('video/');
  // видео без кадра-превью: первый кадр и длительность — из метаданных самого файла (как в Telegram)
  const [len, setLen] = useState(a.duration ?? 0);
  const [frame, setFrame] = useState(false);
  return (
    <button type="button" class="app-media-cell" aria-label={a.name} onClick={() => show(m)}>
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
  // описание — текст сообщения без самой ссылки (если там есть что-то ещё)
  const rest = m.body.replace(raw, '').replace(/\s+/g, ' ').trim();
  return (
    <div class="app-sm-row">
      <span class="app-sm-letter" aria-hidden="true">{(host[0] ?? '?').toUpperCase()}</span>
      <div class="app-sm-text">
        <button type="button" class="app-sm-title app-sm-plain" onClick={() => show(m)}>{host}</button>
        {rest ? <button type="button" class="app-sm-desc app-sm-plain" onClick={() => show(m)}>{rest.slice(0, 170)}</button> : null}
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
