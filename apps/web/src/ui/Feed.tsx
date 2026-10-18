import type { Item } from '@relay/sync-engine/src/types';
import { senderAvatar } from '../profilePhoto';
import type { Entity } from '@relay/protocol';
import { Avatar, Bubble, Icon, peerTone, DateDivider, DatePicker, FileBubble, MediaBubble, MessageText, VoiceBubble, MusicBubble, RoundBubble, player, MediaViewer, ScrollToBottom, beginHeavyAnimation, forceMeasure, isHeavyAnimating, onHeavyAnimationEnd, requestMeasure, requestMutation } from '@relay/ui';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { clearFocus, ensureNames, focusMessage, openInner, jumpToDate, localPreview, markListened, moveWindow, react, savePosition, savedPosition, seen } from '../data';
import { activeFrame, frameByKey, getGlobal, useGlobal } from '../global';
import { toggleMusic, trackTitle, useFileCached } from '../music';
import { showToast } from '../settingsData';
import { startForward, toggleSelect } from '../forward';
import { clock, dayKey, dayLabel, fileSize } from './format';

/*
 * Лента сообщений, устроенная как в Telegram:
 *  • в DOM — окно из двух порций; у краёв — датчики (IntersectionObserver с запасом 750 px),
 *    которые сдвигают окно на порцию, обрезая дальнюю сторону;
 *  • позиция держится по якорю: первый видимый бабл и его отступ — замер до сдвига, запись после;
 *  • строки мемоизированы: неизменённое сообщение — тот же объект, бабл не перерисовывается;
 *  • открытие — на первом непрочитанном (разделитель), на сохранённой позиции или внизу;
 *  • прочтение — по меткам под баблами, раз в 150 мс, пауза на тяжёлых анимациях;
 *  • даты «липнут» к верху и гаснут через секунду после остановки прокрутки.
 */

const EDGE = '750px';     // запас датчиков окна
const EDGE_PX = 750;
const TOP_ZONE = 72;      // шапка (48) + отступ (16) + воздух: выше — под шапкой, не «видно»
const BOTTOM = 50;        // «у низа» — ближе 50 px
const READ_EVERY = 150;   // отправка «вижу до id» не чаще
const FIRST_PAINT = 24;   // при открытии внизу первым кадром — столько последних сообщений, остальное следующим кадром

type Quote = { id: number; sort: number; body: string; senderId: number };
type Att = { id: string; kind: 'photo' | 'file' | 'voice' | 'round' | 'audio'; title?: string | null; performer?: string | null; mime: string; name: string; size: number; w: number | null; h: number | null; thumb?: string | null; duration?: number | null; waveform?: string | null };
const fileUrl = (a: Att, download = false) => `/files/${a.id}${download ? '?download=1' : ''}`;
type RowProps = { chatId: number; voiceTitle: string; author?: string; onAuthor?: (m: Item) => void; onOpen: (m: Item) => void; hl?: string; m: Item; meId: number; out: boolean; start: boolean; end: boolean; pos?: 'single' | 'first' | 'middle' | 'last'; quoted?: Quote | null; quoteAuthor?: string; quoteTone?: number; appear: boolean; flash: boolean; onReact: (m: Item, emoji: string) => void; album?: Item[]; onUser?: (userId: number) => void; sel?: boolean; selIn?: string; onQuickForward?: (m: Item) => void; grp?: boolean };

/** Строка ленты: перерисовывается только если изменилось её сообщение или место в группе. */
const Row = memo(function Row({ chatId, voiceTitle, author, onAuthor, onOpen, hl, m, meId, out, start, end, pos, quoted, quoteAuthor, quoteTone, appear, flash, onReact, album, onUser, sel, selIn, onQuickForward, grp }: RowProps) {
  // реакции: по эмодзи — сколько и есть ли моя
  const list = (m.reactions as { userId: number; emoji: string }[] | undefined) ?? [];
  const chips: { emoji: string; count: number; mine: boolean }[] = [];
  for (const r of list) {
    const c = chips.find((x) => x.emoji === r.emoji);
    if (c) { c.count++; c.mine ||= r.userId === meId; } else chips.push({ emoji: r.emoji, count: 1, mine: r.userId === meId });
  }
  const att = m.attachment as Att | null | undefined;
  // пересланное: «Переслано от» с аватаром и именем автора; клик — чат с ним (себя не открываем)
  const ff = !m.deleted ? m.fwdFrom as { userId: number; name: string; chatId: number; messageId: number } | null | undefined : null;
  const fwd = ff ? { name: ff.name, tone: peerTone(ff.userId), avatar: senderAvatar(ff.userId),
    onClick: ff.userId !== meId && onUser ? () => onUser(ff.userId) : undefined } : undefined;
  // режим выбора: строка отмечается кликом (обработчик — у ленты), кружок-галочка слева
  const wrap = (base: string) => base + (flash ? ' app-msg-flash' : '') + (sel !== undefined ? ' app-msg-sel' : '') + (sel ? ' app-msg-on' : '') + (grp ? ' app-msg-grp' : '');
  // круглая стрелка «Переслать» у пузыря при наведении — у медиа и длинных сообщений (не в режиме выбора)
  // у пересланного, чей исходный чат мне доступен, вместо неё — «→ к оригиналу» (как в Telegram)
  const src = ff && ff.chatId != null && getGlobal().chats.some((c) => c.id === ff.chatId) ? ff : null;
  const aside = sel !== undefined || m.id == null || m.deleted || m.service ? null
    : src ? <button type="button" class="app-fwd-quick" aria-label="Перейти к сообщению" title="Перейти к сообщению" onClick={(e) => { e.stopPropagation(); goToOriginal(src.chatId, src.messageId); }}><Icon name="arrowRight" size={20} /></button>
    : onQuickForward && (att || (m.body as string).length > 300)
      ? <button type="button" class="app-fwd-quick" aria-label="Переслать" title="Переслать" onClick={(e) => { e.stopPropagation(); onQuickForward(album?.[0] ?? m); }}><Icon name="forward" size={20} /></button> : null;
  const check = sel !== undefined ? <span class="app-msg-check" aria-hidden="true"><Icon name="check" size={14} strokeWidth={3} /></span> : null;
  const pending = m.status === 'pending' && typeof m.progress === 'number' && (m.progress as number) < 1;
  const mark = m.id != null ? <i class="app-mark" data-mid={m.id as number} aria-hidden="true" /> : null;
  if (album && album.length > 1) {
    // альбом — фото, отправленные вместе (один groupId): один пузырь с мозаикой, как в Telegram;
    // время и статус — у последнего, подпись — у первого, где она есть
    const last = album[album.length - 1];
    const cap = album.find((x) => x.body);
    const busy = album.some((x) => x.status === 'pending' && typeof x.progress === 'number' && (x.progress as number) < 1);
    return (
      <div class={wrap('app-msg app-msg-media')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <MediaBubble
          fwd={fwd}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          items={album.map((x) => { const a = x.attachment as Att; return { src: localPreview(x.key) ?? (a.id ? fileUrl(a) : undefined), thumb: a.thumb, alt: a.name, w: a.w, h: a.h, mkey: x.key,
            sel: selIn !== undefined ? selIn.split(',').includes(x.key as string) : undefined }; })}
          state={busy ? 'loading' : 'ready'} progress={busy ? Math.min(...album.map((x) => (typeof x.progress === 'number' ? x.progress as number : 1))) : undefined}
          caption={cap ? <MessageText text={cap.body as string} entities={cap.entities as Entity[] | undefined} highlight={hl} /> : undefined}
          time={clock(last.createdAt as string)} status={out ? last.status : undefined}
          onOpen={(i: number) => onOpen(album[i] ?? m)}
        />
        {album.map((x) => (x.id != null ? <i key={x.key} class="app-mark" data-mid={x.id as number} aria-hidden="true" /> : null))}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'photo' && att.w && att.h) {
    // фото знает размеры заранее: рамка нужной высоты сразу, размытое превью, полная картинка — лениво
    const src = localPreview(m.key) ?? (att.id ? fileUrl(att) : undefined);
    return (
      <div class={wrap('app-msg app-msg-media')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <MediaBubble
          fwd={fwd}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          items={[{ src, thumb: att.thumb, alt: att.name }]}
          ratio={`${att.w} / ${att.h}`}
          state={pending ? 'loading' : 'ready'} progress={m.progress as number}
          caption={m.body ? <MessageText text={m.body as string} entities={m.entities as Entity[] | undefined} highlight={hl} /> : undefined}
          time={clock(m.createdAt as string)} status={out ? m.status : undefined}
          onOpen={() => onOpen(m)}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'voice') {
    // голосовое: точка «не прослушано» — пока получатель не включил (у отправителя тоже, как в Telegram)
    const unheard = m.id != null && !m.listened;
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <VoiceBubble
          fwd={fwd}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start} appear={appear}
          trackKey={m.key as string} duration={att.duration ?? 0} waveform={att.waveform ?? null}
          unread={unheard} unreadIncoming={unheard && !out}
          uploading={pending} progress={m.progress as number}
          time={clock(m.createdAt as string)} status={out ? m.status : undefined}
          track={() => voiceTrack(m, att, chatId, voiceTitle, out)}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'round') {
    const unseen = m.id != null && !m.listened;
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <RoundBubble
          fwd={fwd}
          aside={aside}
          from={out ? 'out' : 'in'} groupStart={start} appear={appear}
          src={localPreview(m.key as string) ?? (att.id ? fileUrl(att) : undefined)} thumb={att.thumb ?? null}
          duration={att.duration ?? 0} unread={unseen}
          uploading={pending} progress={m.progress as number}
          time={clock(m.createdAt as string)} status={out ? m.status : undefined}
          onListened={!out && unseen ? () => markListened(chatId, m.id as number) : undefined}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.kind === 'audio') {
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <CachedMusic
          fwd={fwd}
          aside={aside}
          fileId={att.id ?? undefined} from={out ? 'out' : 'in'} tail={end} groupStart={start} pos={pos}
          trackKey={m.key as string} title={att.title || trackTitle(att.name)} performer={att.performer ?? undefined} cover={att.thumb ?? undefined}
          duration={att.duration ?? 0} size={fileSize(att.size)}
          onDownload={att.id ? () => { const a = document.createElement('a'); a.href = fileUrl(att, true); a.download = att.name; a.click(); } : undefined}
          uploading={pending} progress={m.progress as number}
          time={clock(m.createdAt as string)} status={out ? m.status : undefined}
          onToggle={() => {
            // плейлист — музыка загруженного окна ленты, новые сверху
            const list = (activeFrame(getGlobal())?.messages ?? []).filter((x) => !x.deleted && (x.attachment as Att | null)?.kind === 'audio' && x.id != null).reverse();
            toggleMusic(m as never, list as never, chatId);
          }}
        />
        {mark}
      </div>
    );
  }
  if (att && !m.deleted && att.id !== undefined && att.kind === 'file') {
    const ext = (att.name.split('.').pop() ?? 'file').slice(0, 4);
    return (
      <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
        {check}
        <FileBubble
          fwd={fwd}
          aside={aside}
          from={out ? 'out' : 'in'} tail={end} groupStart={start}
          name={att.name} ext={ext} meta={fileSize(att.size)}
          state={pending ? 'loading' : att.id ? 'remote' : 'loading'} progress={m.progress as number}
          time={clock(m.createdAt as string)} status={out ? m.status : undefined}
          onDownload={() => { const a = document.createElement('a'); a.href = fileUrl(att, true); a.download = att.name; a.click(); }}
        />
        {mark}
      </div>
    );
  }
  return (
    <div class={wrap('app-msg')} data-key={m.key} data-sort={m.sort as number}>
      {check}
      <Bubble
        fwd={fwd}
        aside={aside}
        from={out ? 'out' : 'in'}
        tail={end}
        groupStart={start}
        author={author}
        authorTone={author ? peerTone(m.senderId as number) : undefined}
        onAuthorClick={author && onAuthor ? () => onAuthor(m) : undefined}
        reply={quoted ? { author: quoteAuthor, text: quoted.body, tone: quoteTone, onClick: noop } : undefined}
        edited={!!m.editedAt && !m.deleted}
        deleted={!!m.deleted}
        reactions={chips.length ? chips : undefined}
        onReactionClick={(emoji: string) => onReact(m, emoji)}
        time={clock(m.createdAt as string)}
        status={out ? m.status : undefined}
        appear={appear}
      >
        <MessageText text={m.body as string} entities={m.entities as Entity[] | undefined} highlight={hl} />
      </Bubble>
      {m.id != null ? <i class="app-mark" data-mid={m.id as number} aria-hidden="true" /> : null}
    </div>
  );
});

/** «→» у пересланного, как «Focus message» в Telegram: исходный чат открывается поверх текущего (стрелка «Назад»
 *  вернёт обратно); он уже ниже в стеке — возвращаемся к нему; тот же чат — просто прокрутка к оригиналу. */
function goToOriginal(chatId: number, id: number): void {
  const target = { id, sort: id };
  if (activeFrame(getGlobal())?.chatId === chatId) focusMessage(target); else openInner(chatId, target);
}

const noop = () => {}; // цитата — кнопка; сам клик ловит лента (один обработчик на всех)

/** Трек общего плеера для голосового: свой файл до загрузки — локальная копия. Прослушал входящее — отметка. */
function voiceTrack(m: Item, att: Att, chatId: number, author: string, out: boolean) {
  return {
    key: m.key as string,
    kind: 'voice' as const,
    src: localPreview(m.key as string) ?? fileUrl(att),
    duration: att.duration ?? 0,
    title: author,
    subtitle: 'Голосовое сообщение',
    chatId, msgId: (m.id as number | null) ?? null,
    onListened: !out && m.id != null && !m.listened ? () => markListened(chatId, m.id as number) : undefined,
  };
}

/** Первый бабл, видимый ниже шапки, и его отступ от верха ленты (только в фазе замера). */
/** top у липкой даты (зависит от плашки закреплённого): от него считаем, где дата «прилипла». */
function dateTop(root: HTMLElement): number { const d = root.querySelector('.rl-date'); return d ? parseFloat(getComputedStyle(d).top) || 0 : 0; }

const GROUP_GAP_MS = 10 * 60_000;
/** Между a и b группа рвётся: пауза больше 10 минут или b — первое непрочитанное. */
function breaksGroup(a: Item | undefined, b: Item, unreadFrom: number | null, meId: number): boolean {
  if (!a) return true;
  if (Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string) > GROUP_GAP_MS) return true;
  return unreadFrom != null && b.senderId !== meId && b.id != null && (b.id as number) > unreadFrom && (a.id == null || (a.id as number) <= unreadFrom || a.senderId === meId);
}

function firstVisible(root: HTMLElement): { key: string; sort: number; top: number } | null {
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>('.app-msg')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > rootTop + TOP_ZONE) return { key: row.dataset.key!, sort: Number(row.dataset.sort), top: r.top - rootTop };
  }
  return null;
}

const NO_MESSAGES: Item[] = [];

/** Музыкальный пузырь + есть ли файл в кэше (значок «скачать» в углу — только пока файла нет). */
function CachedMusic({ fileId, ...props }: { fileId?: string } & Record<string, unknown>) {
  const downloaded = useFileCached(fileId);
  return <MusicBubble {...props} downloaded={downloaded} />;
}

export function Feed({ frameKey, active, chatId, meId, peerName, group, onAuthor, stick, onMenu, highlight }: {
  frameKey: string; active: boolean;   // кадр стека чатов; active — на экране (только он отмечает прочитанное)
  chatId: number; meId: number; peerName: string; highlight?: string;
  group: boolean; onAuthor: (userId: number) => void;   // в группе — имя автора над пачкой; клик — личный чат поверх
  stick: { current: boolean };
  onMenu: (key: string, x: number, y: number) => void;
}) {
  const messages = useGlobal((s) => frameByKey(s, frameKey)?.messages ?? NO_MESSAGES);
  const names = useGlobal((s) => s.names);
  useGlobal((s) => s.photos);   // фото авторов пришли — аватарки пачек перерисовываются
  // следующее/предыдущее голосовое этого чата — для автоперехода и кнопок плеера
  useEffect(() => {
    if (!active) return;
    player.setQueue((key: string, dir: number) => {
      const list = (frameByKey(getGlobal(), frameKey)?.messages ?? []).filter((x) => !x.deleted && (x.attachment as Att | null)?.kind === 'voice' && x.id != null);
      const i = list.findIndex((x) => x.key === key);
      const n = i < 0 ? null : list[i + dir];
      return n ? voiceTrack(n, n.attachment as Att, chatId, n.senderId === meId ? 'Вы' : peerName, n.senderId === meId) : null;
    });
  }, [chatId, peerName, active]);
  const meta = useGlobal((s) => frameByKey(s, frameKey)?.feedMeta ?? null);
  const unreadFrom = useGlobal((s) => frameByKey(s, frameKey)?.unreadFrom ?? null);
  const focus = useGlobal((s) => frameByKey(s, frameKey)?.focus ?? null);
  const activeRef = useRef(active); activeRef.current = active;
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);   // индекс фото в просмотрщике
  const [pickDate, setPickDate] = useState<Date | null>(null);   // «Перейти к дате» по клику на плашку даты
  const unread = useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.unread as number) ?? 0);
  const el = useRef<HTMLDivElement>(null);
  const metaRef = useRef(meta); metaRef.current = meta;
  const anchor = useRef<{ key: string; top: number } | null>(null);   // якорь до сдвига окна
  const toBottom = useRef(false);                                     // после перехода к хвосту — вниз
  const programmatic = useRef(0);
  const placed = useRef(false);
  const [away, setAway] = useState(false);
  // дешёвый первый показ (как постепенный рендер в tt): открыли внизу — сначала хвост, выше экрана — следующим кадром
  const [partial, setPartial] = useState(() => !unreadFrom && !savedPosition(chatId) && !focus);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null && messages.length) initial.current = new Set(messages.map((m) => m.key));

  /** Сдвиг окна: сначала замер якоря, потом — запрос нового окна. */
  // направление последней прокрутки пользователя: окно двигаем только туда, куда листают. Иначе на коротких
  // сообщениях окно качается — сдвиг к старым оставляет нижний датчик в зоне, он тянет к новым, и так по кругу
  const scrollDir = useRef<-1 | 0 | 1>(0);
  const lastTop = useRef(0);
  const shift = (dir: 'older' | 'newer') => {
    const root = el.current, m = metaRef.current;
    if (!root || !placed.current || !m || (dir === 'older' ? !m.hasOlder : !m.hasNewer)) return;
    if (scrollDir.current === (dir === 'older' ? 1 : -1)) return;
    requestMeasure(() => {
      if (anchor.current) return; // предыдущий сдвиг ещё не применён
      const v = firstVisible(root);
      if (v) anchor.current = { key: v.key, top: v.top };
      moveWindow(dir, frameKey);
    });
  };

  // после каждого обновления окна: первая раскладка, якорь или «прилипание» к низу
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !messages.length) return;
    if (!placed.current) {
      placed.current = true;
      // первый кадр чата — до отрисовки (осознанное исключение): сохранённая позиция → непрочитанное → низ
      forceMeasure(() => {
        const divider = root.querySelector<HTMLElement>('.app-unread-divider');
        const pos = savedPosition(chatId);
        const bottom = root.scrollHeight - root.clientHeight;
        let target = bottom;
        const row = pos ? root.querySelector<HTMLElement>(`[data-key="${CSS.escape(pos.key)}"]`) : null;
        // вернулись в чат, из которого ушли посреди истории, — туда же; иначе к первому непрочитанному
        if (row) target = Math.min(bottom, row.offsetTop - pos!.offset);
        else if (divider) target = Math.min(bottom, divider.offsetTop - TOP_ZONE - 10);
        stick.current = target >= bottom - BOTTOM && !!metaRef.current?.live;
        target = Math.max(0, target);
        if (Math.abs(root.scrollTop - target) > 1) { programmatic.current++; root.scrollTop = target; }
      });
      if (partial) {
        // следующий кадр: якорь — первый видимый, дорисовать строки выше (якорь удержит позицию)
        requestMeasure(() => { const v = firstVisible(root); if (v) anchor.current = { key: v.key, top: v.top }; requestMutation(() => setPartial(false)); });
      }
      return;
    }
    const a = anchor.current, down = toBottom.current;
    if (!a && !down && !stick.current) return;
    // как «forced reflow» в Telegram: поправить прокрутку в том же коммите, до отрисовки — иначе
    // браузер успеет показать кадр со сдвинутым контентом. Одно чтение и одна запись (осознанное исключение)
    forceMeasure(() => {
      const h = root.scrollHeight, top = root.scrollTop, ch = root.clientHeight;
      let next: number | null = null;
      if (a) {
        anchor.current = null;
        const row = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"]`);
        if (row) next = top + (row.getBoundingClientRect().top - root.getBoundingClientRect().top) - a.top;
      } else if (down || (stick.current && top + ch < h - 1)) {
        toBottom.current = false;
        next = h;
      }
      const max = h - ch;
      if (next !== null) next = Math.max(0, Math.min(next, max)); // за пределы браузер не прокрутит — и события не будет
      if (next !== null && Math.abs(next - top) > 0.5) { programmatic.current++; root.scrollTop = next; }
    });
  }, [messages, partial]);

  // высота ленты меняется сверху (выезжает плеер) или снизу (растёт поле ввода) — держим низ на месте, как в Telegram:
  // что было у нижнего края, там и остаётся. Колбэк ResizeObserver — после раскладки, до отрисовки, без лишнего кадра
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    let last = root.clientHeight;
    const ro = new ResizeObserver(() => {
      const ch = root.clientHeight, d = last - ch;
      last = ch;
      if (!d || !placed.current) return;
      const max = root.scrollHeight - ch;
      const next = stick.current ? max : Math.max(0, Math.min(max, root.scrollTop + d));
      if (Math.abs(next - root.scrollTop) > 0.5) { programmatic.current++; root.scrollTop = next; }
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // датчики у краёв окна: видны с запасом 750 px — сдвигаем окно; новые датчики (по ключу) срабатывают сразу
  const edges = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    edges.current = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) shift((e.target as HTMLElement).dataset.dir as 'older' | 'newer');
    }, { root: el.current, rootMargin: `${EDGE} 0px` });
    return () => edges.current?.disconnect();
  }, [chatId]);

  const scheduleRead = useRef<(() => void) | null>(null);   // вернулись к чату (верхний сняли) — отметить то, что видно
  // прочтение: метки под баблами (видна нижняя кромка — прочитано), отправка раз в 150 мс, пауза на тяжёлых анимациях
  const marks = useRef<IntersectionObserver | null>(null);
  const visible = useRef(new Set<number>());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const flush = () => {
      readTimer.current = null;
      if (isHeavyAnimating()) { onHeavyAnimationEnd(flush); return; }
      if (!activeRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let max = 0;
      for (const id of visible.current) if (id > max) max = id;
      if (max) seen(chatId, max);
    };
    const schedule = () => { if (!readTimer.current) readTimer.current = setTimeout(flush, READ_EVERY); };
    // низ зоны — верх композера: лента уходит под него на свой нижний отступ (--bottom-zone + 8 px), а он
    // меняется вместе с высотой композера. Число здесь отрезало последнее сообщение, и оно не читалось никогда.
    // Чтение стиля до отрисовки — осознанное исключение, как у якоря прокрутки
    let underComposer = 0;
    forceMeasure(() => { if (el.current) underComposer = Math.max(0, parseFloat(getComputedStyle(el.current).paddingBottom) - 8); });
    marks.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = Number((e.target as HTMLElement).dataset.mid);
        if (e.isIntersecting) visible.current.add(id); else visible.current.delete(id);
      }
      schedule();
    }, { root: el.current, rootMargin: `-${TOP_ZONE}px 0px -${underComposer}px 0px` });
    addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    scheduleRead.current = schedule;
    return () => {
      marks.current?.disconnect();
      if (readTimer.current) clearTimeout(readTimer.current);
      removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [chatId]);

  useEffect(() => { if (active) scheduleRead.current?.(); }, [active]);

  // наблюдать новые датчики и метки, отпускать ушедшие из окна
  const watched = useRef(new Set<Element>());
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    for (const t of watched.current) if (!t.isConnected) { edges.current?.unobserve(t); marks.current?.unobserve(t); watched.current.delete(t); }
    root.querySelectorAll('.app-sentinel').forEach((t) => { if (!watched.current.has(t)) { edges.current?.observe(t); watched.current.add(t); } });
    root.querySelectorAll('.app-mark').forEach((t) => { if (!watched.current.has(t)) { marks.current?.observe(t); watched.current.add(t); } });
  });

  // «липкие» даты: пока листают — видны; через секунду тишины прилипшие гаснут
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrolling = useRef(false);
  // как в Telegram: наверху видна только дата текущего дня; прилипшие раньше прячутся (иначе лежат стопкой),
  // а подъезжающая следующая дата выталкивает текущую вверх
  const pushing = useRef(false);
  const pushDates = (root: HTMLElement) => {
    if (pushing.current) return;
    pushing.current = true;
    requestMeasure(() => {
      pushing.current = false;
      const stickAt = root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop) + dateTop(root);
      const dates = [...root.querySelectorAll<HTMLElement>('.rl-date')];
      const tops = dates.map((d) => d.getBoundingClientRect().top);
      let cur = -1;
      tops.forEach((t, i) => { if (t <= stickAt + 2) cur = i; });
      const h = cur >= 0 ? dates[cur].offsetHeight : 0;
      const gap = cur >= 0 && cur + 1 < dates.length ? tops[cur + 1] - stickAt : Infinity;
      const shift = gap < h ? gap - h : 0;
      requestMutation(() => dates.forEach((d, i) => {
        d.classList.toggle('covered', i < cur);
        d.style.transform = i === cur && shift ? `translateY(${shift}px)` : '';
      }));
    });
  };

  const onScrollDates = (root: HTMLElement) => {
    if (!scrolling.current) {
      scrolling.current = true;
      requestMutation(() => root.querySelectorAll('.rl-date.stuck').forEach((d) => d.classList.remove('stuck')));
    }
    pushDates(root);
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = setTimeout(() => {
      scrolling.current = false;
      requestMeasure(() => {
        const stickAt = root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop) + dateTop(root); // padding ленты + top у .rl-date
        const stuck = [...root.querySelectorAll<HTMLElement>('.rl-date')].filter((d) => Math.abs(d.getBoundingClientRect().top - stickAt) < 3);
        requestMutation(() => stuck.forEach((d) => d.classList.add('stuck')));
      });
    }, 1000);
  };

  // позиция чата — запоминаем через 200 мс после остановки прокрутки
  const posTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storePosition = (root: HTMLElement) => {
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM && (metaRef.current?.live ?? true);
    const v = atBottom ? null : firstVisible(root);
    savePosition(chatId, v ? { key: v.key, sort: v.sort, offset: v.top } : null);
  };
  // уходим из чата, а сохранение ещё ждёт паузы — сохранить сейчас (DOM ещё на месте)
  useLayoutEffect(() => () => {
    const root = el.current;
    if (posTimer.current && root) { clearTimeout(posTimer.current); forceMeasure(() => storePosition(root)); }
  }, []);
  function onScroll() {
    const root = el.current!;
    onScrollDates(root);
    // позицию — после любой прокрутки, в том числе нашей (после сдвига окна якорь тоже меняется)
    if (posTimer.current) clearTimeout(posTimer.current);
    posTimer.current = setTimeout(() => { posTimer.current = null; requestMeasure(() => storePosition(root)); }, 200);
    const top = root.scrollTop, prev = lastTop.current;
    lastTop.current = top;
    if (programmatic.current > 0) { programmatic.current--; return; } // наша прокрутка не меняет «прижата к низу»
    if (top !== prev) scrollDir.current = top < prev ? -1 : 1;
    requestMeasure(() => {
      const fromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      // датчик края уже в зоне (его пропустили, пока листали в другую сторону) — сдвигаем по прокрутке
      if (scrollDir.current < 0 && root.scrollTop < EDGE_PX) shift('older');
      else if (scrollDir.current > 0 && fromBottom < EDGE_PX) shift('newer');
      const live = metaRef.current?.live ?? true;
      stick.current = fromBottom < BOTTOM && live;
      setAway(fromBottom > root.clientHeight || !live);
    });
  }

  const toLatest = () => {
    stick.current = true;
    const root = el.current!;
    if (metaRef.current && !metaRef.current.live) { toBottom.current = true; moveWindow('latest', frameKey); return; }
    requestMeasure(() => { const top = root.scrollHeight; requestMutation(() => root.scrollTo({ top, behavior: 'smooth' })); });
  };

  // переход к сообщению: строка в окне — плавно к ней (по центру) и подсветить; нет — ждём новое окно
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !focus || !placed.current) return;
    const row = root.querySelector<HTMLElement>(`.app-msg[data-sort="${focus.sort}"]`);
    if (!row) return;
    clearFocus(frameKey);
    stick.current = false;
    anchor.current = null;
    setFlashKey(row.dataset.key!);
    if (focus.replaced) {
      // окно заменили целиком — сразу по центру, до отрисовки (иначе кадр со старой позицией и долгая прокрутка)
      forceMeasure(() => {
        const top = Math.max(0, row.offsetTop - (root.clientHeight - row.offsetHeight) / 2);
        if (Math.abs(root.scrollTop - top) > 1) { programmatic.current++; root.scrollTop = top; }
      });
    } else {
      requestMeasure(() => {
        const top = Math.max(0, row.offsetTop - (root.clientHeight - row.offsetHeight) / 2);
        const from = root.scrollTop, h = root.clientHeight;
        requestMutation(() => {
          // как в Telegram: далеко — сначала прыжок почти к цели, плавно — только последний экран
          // (иначе прокрутка пролетает десятки пузырей и кружков, каждый из которых просыпается — кадры проседают)
          if (Math.abs(top - from) > h * 2) { programmatic.current++; root.scrollTop = top + (top > from ? -h : h); }
          // пока едем — тяжёлая анимация: кружки не запускают видео, отложенная работа ждёт
          const end = beginHeavyAnimation(1200);
          const done = () => { root.removeEventListener('scrollend', done); end(); };
          root.addEventListener('scrollend', done);
          root.scrollTo({ top, behavior: 'smooth' });
        });
      });
    }
  }, [focus, messages]);
  // полоса гаснет сама; таймер — свой: сброс focus выше перезапускает эффект перехода и снял бы его
  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [flashKey]);

  // клик по цитате — к исходному сообщению; по моноширинному фрагменту (код входа) — копировать его.
  // Делегирование: один обработчик на ленту, а не на каждый бабл
  // режим выбора: клик по строке отмечает её (у альбома — все фото); ловим на погружении — ссылки, фото
  // и кнопки внутри пузыря не срабатывают
  const onSelectClick = (e: MouseEvent) => {
    const row = (e.target as Element).closest<HTMLElement>('.app-msg');
    const m = row ? messages.find((x) => x.key === row.dataset.key) : undefined;
    if (!m) return;
    e.preventDefault(); e.stopPropagation();
    // фото альбома — отмечается по отдельности (как в Telegram); кружок слева и подпись — весь альбом
    const cell = (e.target as Element).closest<HTMLElement>('.rl-media-mosaic [data-mkey], .rl-media-album [data-mkey]');
    if (cell?.dataset.mkey) { toggleSelect(chatId, [cell.dataset.mkey]); return; }
    if (m.id == null || m.deleted || m.service) return;
    toggleSelect(chatId, (m.groupId ? messages.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m]).map((x) => x.key as string));
  };
  const onClick = (e: MouseEvent) => {
    if (copyCode(e)) return;
    const quote = (e.target as Element).closest('.rl-quote');
    const row = quote?.closest<HTMLElement>('.app-msg');
    if (!row) return;
    const m = messages.find((x) => x.key === row.dataset.key);
    const r = m?.reply as Quote | null | undefined;
    if (r) focusMessage({ id: r.id, sort: r.sort });
  };

  // моноширинный фрагмент (не блок кода): клик копирует. Ссылку и скрытый спойлер не перехватываем —
  // у них свой клик (переход, раскрытие); выделение текста мышью — тоже не клик по коду
  const copyCode = (e: MouseEvent): boolean => {
    const t = e.target as Element;
    const code = t.closest('.rl-bubble code.rl-code');
    if (!code || e.defaultPrevented || t.closest('a') || t.closest('.rl-spoiler:not(.rl-spoiler-open)')) return false;
    if (getSelection()?.toString()) return false;
    navigator.clipboard?.writeText(code.textContent ?? '').then(() => showToast('Код скопирован')).catch(() => { /* буфер недоступен */ });
    return true;
  };

  // реакция под баблом: своя — снять, чужая — поставить такую же
  const onReact = useRef((m: Item, emoji: string) => {
    if (m.id == null) return;
    const mine = ((m.reactions as { userId: number; emoji: string }[] | undefined) ?? []).find((r) => r.userId === meId);
    react(chatId, m.id as number, mine?.emoji === emoji ? null : emoji);
  }).current;

  // просмотрщик: все фото текущего окна ленты
  const photos = messages.filter((m) => !m.deleted && (m.attachment as Att | null)?.kind === 'photo' && (m.attachment as Att).w);
  const openIndex = viewer === null ? null : viewer < 0 ? -1 - viewer : viewer;
  // миниатюра k-го фото в ленте: из неё вьювер вылетает и в неё же возвращается (нет в окне — просто тает)
  const photoKeys = photos.map((m) => m.key);
  // авторы фото — во вьювере всегда имя отправителя; подгружаем заранее, пока вьювер закрыт
  const authorIds = [...new Set(photos.map((m) => m.senderId as number))].join(',');
  useEffect(() => { if (authorIds) ensureNames(authorIds.split(',').map(Number)); }, [authorIds]);
  const keysRef = useRef(photoKeys); keysRef.current = photoKeys;
  // ключи — из ref: колбэк стабилен (строки мемоизированы), а список фото растёт с новыми сообщениями
  const onOpen = useRef((m: Item) => { const k = keysRef.current.indexOf(m.key); if (k >= 0) setViewer(-1 - k); }).current;
  const originOf = useRef((k: number) => {
    const key = keysRef.current[k];
    // плитка альбома помечена ключом своего сообщения (data-mkey), одиночное фото — ключом строки
    return key ? el.current?.querySelector<HTMLElement>(`[data-mkey="${CSS.escape(key)}"], [data-key="${CSS.escape(key)}"] .rl-media-cell`) ?? null : null;
  }).current;

  const authorRef = useRef(onAuthor); authorRef.current = onAuthor;
  const onAuthorRow = useRef((m: Item) => authorRef.current(m.senderId as number)).current;
  const onUserRow = useRef((userId: number) => authorRef.current(userId)).current;
  const selecting = useGlobal((s) => (s.selecting?.chatId === chatId ? s.selecting.keys : null));
  // режим выбора, как в Telegram: входящие плавно сдвигаются вправо (transform, без перестройки), кружки проявляются;
  // при выходе — всё обратно, поэтому кружки и отметки живут ещё 220 мс. selOn — второй кадр: переход с места, а не скачок
  const lastSel = useRef<string[] | null>(null);
  if (selecting) lastSel.current = selecting;
  const [selVis, setSelVis] = useState(!!selecting);
  const [selOn, setSelOn] = useState(!!selecting);
  useEffect(() => {
    if (selecting) {
      setSelVis(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setSelOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setSelOn(false);
    const t = setTimeout(() => { setSelVis(false); lastSel.current = null; }, 220);
    return () => clearTimeout(t);
  }, [!!selecting]);
  const selShown = selecting ?? (selVis ? lastSel.current : null);
  const me = useGlobal((s) => s.me);
  const nameOf = (id: number) => (id === meId ? me?.name ?? '' : names[id] ?? peerName);
  const nameRef = useRef(nameOf); nameRef.current = nameOf;
  const msgsRef = useRef<Item[]>([]);
  msgsRef.current = messages;
  // круглая стрелка у пузыря: альбом — целиком
  const onQuickForward = useRef((m: Item) => {
    const all = msgsRef.current;
    startForward(chatId, m.groupId ? all.filter((x) => x.groupId === m.groupId && x.senderId === m.senderId) : [m], nameRef.current);
  }).current;
  useEffect(() => { if (group) ensureNames([...new Set(messages.filter((m) => m.senderId !== meId).map((m) => m.senderId as number))]); }, [group, messages]);

  // контекстное меню — одно на ленту, а не на каждый бабл (иначе обработчик ломал бы мемоизацию строк)
  const onContextMenu = (e: MouseEvent) => {
    const row = (e.target as Element).closest<HTMLElement>('.app-msg');
    if (!row) return;
    e.preventDefault();
    onMenu(row.dataset.key!, e.clientX, e.clientY);
  };

  const out: unknown[] = [];
  let prevDay = '', prevSender: unknown = null, unreadShown = false;
  if (!partial) out.push(<div class="app-sentinel" data-dir="older" key={'o' + (messages[0]?.key ?? '')} aria-hidden="true" />);
  const shown = partial && messages.length > FIRST_PAINT ? messages.slice(messages.length - FIRST_PAINT) : messages;
  // альбомы: подряд идущие фото одного отправителя с общим groupId (до 10) — одной строкой с мозаикой
  const isPhoto = (x: Item | undefined) => !!x && !x.deleted && (x.attachment as Att | null)?.kind === 'photo' && !!(x.attachment as Att).w && !!(x.attachment as Att).h;
  const albums = new Map<string, Item[]>(), inAlbum = new Set<string>();
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    if (!m.groupId || !isPhoto(m) || inAlbum.has(m.key)) continue;
    const run = [m];
    while (run.length < 10) { const x = shown[i + run.length]; if (!isPhoto(x) || x.groupId !== m.groupId || x.senderId !== m.senderId) break; run.push(x); }
    if (run.length > 1) { albums.set(m.key, run); run.slice(1).forEach((x) => inAlbum.add(x.key)); }
  }
  // в группе входящие одного автора — «пачка» в общей обёртке: аватар автора внизу пачки липкий (sticky), как в Telegram —
  // при прокрутке длинной пачки он держится у низа экрана и уезжает вместе с её началом
  let run: preact.VNode[] | null = null, runKey = '', runSender = 0;
  const flushRun = () => {
    if (!run) return;
    const sid = runSender, who = names[sid] ?? '';
    out.push(
      <div class="app-run" key={'run' + runKey}>
        {run}
        <button type="button" class="app-run-ava" aria-label={who || 'Автор'} tabIndex={-1} onClick={(e) => { e.stopPropagation(); onUserRow(sid); }}>
          <Avatar name={who} tone={peerTone(sid)} size={34} {...senderAvatar(sid)} />
        </button>
      </div>,
    );
    run = null;
  };
  shown.forEach((m, i) => {
    if (inAlbum.has(m.key)) return;   // уже нарисовано в альбоме выше
    const day = dayKey(m.createdAt as string);
    const mine = m.senderId === meId;
    if (day !== prevDay) flushRun();
    if (day !== prevDay) { const at = m.createdAt as string; out.push(<DateDivider key={'d' + day} onClick={() => setPickDate(new Date(at))}>{dayLabel(at)}</DateDivider>); }
    if (!unreadShown && unreadFrom != null && !mine && m.id != null && (m.id as number) > unreadFrom) {
      unreadShown = true;
      flushRun();
      out.push(<div class="app-unread-divider" key="unread" role="separator"><span>Непрочитанные сообщения</span></div>);
    }
    // служебное «создал(а) группу» — плашкой по центру, как в Telegram (не пузырём)
    if ((m.service as { type?: string } | undefined)?.type === 'group_created') {
      const who = mine ? 'Вы создали' : `${names[m.senderId as number] ?? peerName} создал(а)`;
      flushRun();
      out.push(<div class="rl-action" key={m.key} role="note"><span>{who} группу «{m.body as string}»</span></div>);
      prevDay = day; prevSender = null;
      return;
    }
    const album = albums.get(m.key);
    const next = shown[i + (album ? album.length : 1)];
    // группа — как в Telegram: тот же отправитель и день, пауза не больше 10 минут, не на границе «Непрочитанные»
    const start = prevSender !== m.senderId || day !== prevDay || breaksGroup(shown[i - 1], m, unreadFrom, meId);
    const end = !next || next.senderId !== m.senderId || dayKey(next.createdAt as string) !== day || breaksGroup(m, next, unreadFrom, meId);
    const quoted = m.reply as Quote | null;
    // файлы, отправленные вместе (groupId), — одним пузырём: позиция строки внутри группы
    const prevM = shown[i - 1];
    const same = (x: Item | undefined) => !!x && !!m.groupId && x.groupId === m.groupId && x.senderId === m.senderId && !x.deleted;
    const pos = !m.groupId || m.deleted ? 'single' : same(prevM) && same(next) ? 'middle' : same(prevM) ? 'last' : same(next) ? 'first' : 'single';
    const row = (
      <Row
        pos={pos}
        key={m.key}
        author={group && !mine && start && !m.deleted ? names[m.senderId as number] ?? '' : undefined}
        onAuthor={onAuthorRow}
        onUser={onUserRow}
        sel={selShown ? (album ?? [m]).every((x) => selShown.includes(x.key as string)) : undefined}
        selIn={selShown && album ? album.filter((x) => selShown.includes(x.key as string)).map((x) => x.key).join(',') : undefined}
        grp={group && !mine}
        onQuickForward={onQuickForward}
        hl={highlight && (m.body as string).toLowerCase().includes(highlight.toLowerCase()) ? highlight : undefined}
        m={m}
        meId={meId}
        chatId={chatId}
        voiceTitle={mine ? 'Вы' : (group ? names[m.senderId as number] ?? peerName : peerName)}
        onReact={onReact}
        onOpen={onOpen}
        out={mine}
        start={start}
        end={end}
        quoted={quoted}
        quoteAuthor={quoted ? (quoted.senderId === meId ? 'Вы' : group ? names[quoted.senderId as number] ?? '' : peerName) : undefined}
        quoteTone={quoted ? peerTone(quoted.senderId as number) : undefined}
        appear={initial.current !== null && !initial.current.has(m.key)}
        flash={flashKey === m.key || !!album?.some((x) => x.key === flashKey)}
        album={album}
      />
    );
    if (group && !mine) {
      if (run && (start || runSender !== m.senderId)) flushRun();
      if (!run) { run = []; runKey = m.key as string; runSender = m.senderId as number; }
      run.push(row);
      if (end) flushRun();
    } else {
      flushRun();
      out.push(row);
    }
    prevDay = day; prevSender = m.senderId;
  });
  flushRun();
  out.push(<div class="app-sentinel" data-dir="newer" key={'n' + (messages[messages.length - 1]?.key ?? '')} aria-hidden="true" />);

  return (
    <>
      <div class={'rl-feed' + (selVis ? ' app-feed-selecting' : '') + (selOn && selecting ? ' app-feed-sel-on' : '')} ref={el} onScroll={onScroll} onClick={onClick} onClickCapture={selecting ? onSelectClick : undefined} onContextMenu={onContextMenu} aria-live="polite">{out}</div>
      {openIndex !== null && photos[openIndex] ? (
        <MediaViewer
          index={openIndex}
          sender={peerName}
          items={photos.map((m) => { const a = m.attachment as Att; return { sender: names[m.senderId as number] ?? '', avatar: senderAvatar(m.senderId as number),   // не название группы: пока имени нет — пусто, оно подгружается заранее
 src: localPreview(m.key) ?? fileUrl(a), thumb: a.thumb, w: a.w, h: a.h, name: a.name, download: fileUrl(a, true), caption: m.body, date: clock(m.createdAt as string) }; })}
          origin={originOf}
          actions={(_it: unknown, i: number) => [{ icon: 'forward', label: 'Переслать', onClick: () => { const p = photos[i]; setViewer(null); if (p) startForward(chatId, [p], nameOf); } }]}
          onClose={() => setViewer(null)}
        />
      ) : null}
      <DatePicker open={!!pickDate} value={pickDate ?? undefined} onClose={() => setPickDate(null)}
        onPick={(d: Date) => { setPickDate(null); void jumpToDate(chatId, d).then((ok) => { if (!ok) showToast('В этот день сообщений нет'); }); }} />
      <div class="rl-scrolldown-slot">
        <ScrollToBottom show={away || (meta ? !meta.live : false)} unread={unread} onClick={toLatest} />
      </div>
    </>
  );
}
