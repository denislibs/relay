// «Музыка» из меню вложений, как в Telegram Web: поиск, «Выбрать из файлов», музыка профиля и музыка из чатов.
// Клик по строке — отправить трек (тот же файл, без новой загрузки); клик по кругу — послушать (кольцо вокруг обложки
// пляшет под звук). Поиск — с 3 символов, через 300 мс; ответы на устаревший запрос отбрасываются.
import { Icon, Modal, PlayingRing, SearchInput, player } from '@relay/ui';
import type { Message } from '@relay/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { forwardMessages, sendFiles, sendTrack, sentSound } from '../data';
import { getGlobal } from '../global';
import { trackTitle } from '../music';
import { useProfileMusic, type ProfileTrack } from '../profileLists';
import { searchGlobalMedia, type MediaHit } from '../search';
import { showToast } from '../settingsData';
import { dur as fmtDur } from './SharedMedia';

type Row = { key: string; title: string; sub: string; duration: number; src: string; cover?: string | null; send: () => void };

const MIN_QUERY = 3;

/** Строка трека: круг с обложкой и play/pause (+ кольцо у текущего), название, «длительность • исполнитель». */
function TrackLine({ r }: { r: Row }) {
  const [st, setSt] = useState(() => player.playerState());
  useEffect(() => player.subscribe(setSt), []);
  const current = st.key === r.key, playing = current && st.playing;
  const listen = (e: MouseEvent) => {
    e.stopPropagation();
    player.setPlaylist(null);
    player.toggle({ key: r.key, kind: 'music', src: r.src, duration: r.duration, title: r.title, performer: r.sub });
  };
  return (
    <div class="app-mp-row" role="button" tabIndex={0} onClick={r.send}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); r.send(); } }}>
      <span class="app-mp-cover">
        <button type="button" class={'app-mp-play' + (r.cover ? ' app-mp-play-cover' : '')} style={r.cover ? { backgroundImage: `url(${r.cover})` } : undefined}
          aria-label={playing ? 'Пауза' : 'Послушать'} onClick={listen}>
          <Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
        {current ? <PlayingRing paused={!playing} /> : null}
      </span>
      <span class="app-mp-text">
        <b>{r.title}</b>
        <small>{fmtDur(r.duration)}{r.sub ? ' • ' + r.sub : ''}</small>
      </span>
    </div>
  );
}

/** replyToId — открытый в поле ответ: трек уходит ответом на него (как любое сообщение); onSent — ответ отработан, снять его. */
export function MusicPicker({ chatId, open, onClose, replyToId = null, onSent }: { chatId: number; open: boolean; onClose: () => void; replyToId?: number | null; onSent?: () => void }) {
  const [q, setQ] = useState('');
  const profile: ProfileTrack[] | null = useProfileMusic(open ? getGlobal().me?.userId : null)?.tracks ?? null;
  const [shared, setShared] = useState<{ hits: MediaHit[]; more: boolean; loading: boolean; next?: number }>({ hits: [], more: true, loading: false });
  const [found, setFound] = useState<{ q: string; hits: MediaHit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const gen = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const query = q.trim();
  const searchMode = query.length >= MIN_QUERY;

  // открыли — свежие списки
  useEffect(() => {
    if (!open) return;
    setQ(''); setFound(null);
    setShared({ hits: [], more: true, loading: false });
    void loadShared(true);
  }, [open]);

  async function loadShared(fresh = false) {
    const cur = fresh ? { hits: [], more: true, loading: false } : shared;
    if (cur.loading || !cur.more) return;
    setShared({ ...cur, loading: true });
    try {
      const last = cur.hits[cur.hits.length - 1];
      const r = await searchGlobalMedia('audio', '', cur.next ?? last?.message.id);
      setShared((s) => ({ hits: dedupe([...(fresh ? [] : s.hits), ...r.hits]), more: r.hasMore, loading: false, next: r.next }));
    } catch { setShared((s) => ({ ...s, loading: false })); }
  }

  // поиск: 300 мс тишины, с 3 символов; устаревший ответ — мимо
  useEffect(() => {
    if (!searchMode) { setSearching(false); return; }
    setSearching(true);
    const my = ++gen.current;
    const t = setTimeout(() => {
      searchGlobalMedia('audio', query).then((r) => { if (gen.current === my) { setFound({ q: query, hits: dedupe(r.hits) }); setSearching(false); } },
        () => { if (gen.current === my) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // бесконечная прокрутка «Из чатов»
  useEffect(() => {
    const el = sentinel.current;
    if (!el || searchMode) return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) void loadShared(); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  });

  const close = () => onClose();
  const sendHit = (h: MediaHit) => {
    close();
    sentSound();
    // трек из чата — его же файл, без «Переслано» и без подписи (как отправка музыки в Telegram)
    void forwardMessages({ fromChatId: h.message.chatId, ids: [h.message.id], toChatIds: [chatId], hideSender: true, hideCaption: true, replyToId });
    onSent?.();
  };
  const sendProfile = (t: ProfileTrack) => {
    close();
    void sendTrack(chatId, { id: t.id, kind: 'audio', mime: t.mime, name: t.title, size: 0, w: null, h: null, duration: t.duration ?? null, title: t.title }, replyToId);
    onSent?.();
  };
  const pickFile = () => file.current?.click();
  const onFile = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type)) { showToast('Это не аудиофайл — выберите музыку'); return; }
    close();
    void sendFiles(chatId, [f], '', replyToId);
    onSent?.();
  };

  const hitRow = (h: MediaHit): Row => {
    const m = h.message as Message, a = m.attachment!;
    return { key: 'mp:' + m.chatId + ':' + m.id, title: a.title || trackTitle(a.name), sub: a.performer || h.chatTitle || '', duration: a.duration ?? 0,
      src: `/files/${a.id}`, cover: a.thumb ?? null, send: () => sendHit(h) };
  };
  const profRow = (t: ProfileTrack): Row => ({ key: 'mp:p:' + t.id, title: trackTitle(t.title), sub: 'в профиле', duration: t.duration ?? 0, src: `/files/${t.id}`, send: () => sendProfile(t) });

  const profRows = (profile ?? []).map(profRow);
  const sharedRows = shared.hits.map(hitRow);
  const listKey = searchMode ? 'q:' + (found?.q ?? '') : 'default';

  return (
    <Modal open={open} onClose={close} title="Музыка" size="slim" class="app-mp" bodyClass="app-mp-body">
      <div class="app-mp-search">
        <SearchInput id="app-mp-q" label="Поиск музыки" placeholder="Поиск музыки" value={q} busy={searching}
          onInput={(e: Event) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="app-mp-island">
        <button type="button" class="app-mp-files" onClick={pickFile}>Выбрать из файлов</button>
      </div>
      <input ref={file} type="file" accept="audio/*" hidden onChange={onFile} />
      <div class="app-mp-lists" key={listKey}>
        {searchMode ? (
          found && found.q === query ? (found.hits.length ? (
            <>
              <div class="app-mp-caption">Результаты поиска</div>
              <div class="app-mp-island app-mp-list">{found.hits.map(hitRow).map((r) => <TrackLine key={r.key} r={r} />)}</div>
            </>
          ) : <Empty title="Ничего не найдено" text={`По запросу «${query}» музыки нет.`} />) : null
        ) : profile === null && !shared.hits.length ? null : !profRows.length && !sharedRows.length && !shared.loading ? (
          <Empty title="Здесь пока нет музыки" text="Отправьте трек из файлов — он появится здесь." />
        ) : (
          <>
            {profRows.length ? (
              <>
                <div class="app-mp-caption">В профиле</div>
                <div class="app-mp-island app-mp-list">{profRows.map((r) => <TrackLine key={r.key} r={r} />)}</div>
              </>
            ) : null}
            {sharedRows.length ? (
              <>
                <div class="app-mp-caption">Из чатов</div>
                <div class="app-mp-island app-mp-list">{sharedRows.map((r) => <TrackLine key={r.key} r={r} />)}</div>
              </>
            ) : null}
            <div ref={sentinel} class="app-mp-sentinel" aria-hidden="true" />
          </>
        )}
      </div>
    </Modal>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div class="app-mp-empty"><b>{title}</b><span>{text}</span></div>;
}

/** Один и тот же файл, отправленный несколько раз, — одной строкой (как «общая музыка» в Telegram — по сообщениям,
 *  но повторы одного файла подряд выглядят как ошибка). */
function dedupe(hits: MediaHit[]): MediaHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => { const id = h.message.attachment?.id ?? String(h.message.id); if (seen.has(id)) return false; seen.add(id); return true; });
}
