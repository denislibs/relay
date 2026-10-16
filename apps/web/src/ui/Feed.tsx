import type { Item } from '@relay/sync-engine/src/types';
import { Bubble, DateDivider, ScrollToBottom, forceMeasure, isHeavyAnimating, onHeavyAnimationEnd, requestMeasure, requestMutation } from '@relay/ui';
import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { focusMessage, moveWindow, savePosition, savedPosition, seen } from '../data';
import { setGlobal, useGlobal } from '../global';
import { clock, dayKey, dayLabel } from './format';

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
const TOP_ZONE = 72;      // шапка (48) + отступ (16) + воздух: выше — под шапкой, не «видно»
const BOTTOM = 50;        // «у низа» — ближе 50 px
const READ_EVERY = 150;   // отправка «вижу до id» не чаще
const FIRST_PAINT = 24;   // при открытии внизу первым кадром — столько последних сообщений, остальное следующим кадром

type Quote = { id: number; sort: number; body: string; senderId: number };
type RowProps = { m: Item; out: boolean; start: boolean; end: boolean; quoted?: Quote | null; quoteAuthor?: string; quoteTone?: number; appear: boolean; flash: boolean };

/** Строка ленты: перерисовывается только если изменилось её сообщение или место в группе. */
const Row = memo(function Row({ m, out, start, end, quoted, quoteAuthor, quoteTone, appear, flash }: RowProps) {
  return (
    <div class="app-msg" data-key={m.key} data-sort={m.sort as number}>
      <Bubble
        from={out ? 'out' : 'in'}
        tail={end}
        groupStart={start}
        reply={quoted ? { author: quoteAuthor, text: quoted.body, tone: quoteTone, onClick: noop } : undefined}
        flash={flash}
        time={clock(m.createdAt as string)}
        status={out ? m.status : undefined}
        appear={appear}
      >
        {m.body}
      </Bubble>
      {m.id != null ? <i class="app-mark" data-mid={m.id as number} aria-hidden="true" /> : null}
    </div>
  );
});

const noop = () => {}; // цитата — кнопка; сам клик ловит лента (один обработчик на всех)

/** Первый бабл, видимый ниже шапки, и его отступ от верха ленты (только в фазе замера). */
function firstVisible(root: HTMLElement): { key: string; sort: number; top: number } | null {
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>('.app-msg')) {
    const r = row.getBoundingClientRect();
    if (r.bottom > rootTop + TOP_ZONE) return { key: row.dataset.key!, sort: Number(row.dataset.sort), top: r.top - rootTop };
  }
  return null;
}

export function Feed({ chatId, meId, peerName, stick, onMenu }: {
  chatId: number; meId: number; peerName: string;
  stick: { current: boolean };
  onMenu: (key: string, x: number, y: number) => void;
}) {
  const messages = useGlobal((s) => s.messages);
  const meta = useGlobal((s) => s.feedMeta);
  const unreadFrom = useGlobal((s) => s.unreadFrom);
  const focus = useGlobal((s) => s.focus);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const unread = useGlobal((s) => (s.chats.find((c) => c.id === chatId)?.unread as number) ?? 0);
  const el = useRef<HTMLDivElement>(null);
  const metaRef = useRef(meta); metaRef.current = meta;
  const anchor = useRef<{ key: string; top: number } | null>(null);   // якорь до сдвига окна
  const toBottom = useRef(false);                                     // после перехода к хвосту — вниз
  const programmatic = useRef(0);
  const placed = useRef(false);
  const [away, setAway] = useState(false);
  // дешёвый первый показ (как постепенный рендер в tt): открыли внизу — сначала хвост, выше экрана — следующим кадром
  const [partial, setPartial] = useState(() => !unreadFrom && !savedPosition(chatId));
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null && messages.length) initial.current = new Set(messages.map((m) => m.key));

  /** Сдвиг окна: сначала замер якоря, потом — запрос нового окна. */
  const shift = (dir: 'older' | 'newer') => {
    const root = el.current, m = metaRef.current;
    if (!root || !placed.current || !m || (dir === 'older' ? !m.hasOlder : !m.hasNewer)) return;
    requestMeasure(() => {
      if (anchor.current) return; // предыдущий сдвиг ещё не применён
      const v = firstVisible(root);
      if (v) anchor.current = { key: v.key, top: v.top };
      moveWindow(dir);
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

  // датчики у краёв окна: видны с запасом 750 px — сдвигаем окно; новые датчики (по ключу) срабатывают сразу
  const edges = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    edges.current = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) shift((e.target as HTMLElement).dataset.dir as 'older' | 'newer');
    }, { root: el.current, rootMargin: `${EDGE} 0px` });
    return () => edges.current?.disconnect();
  }, [chatId]);

  // прочтение: метки под баблами (видна нижняя кромка — прочитано), отправка раз в 150 мс, пауза на тяжёлых анимациях
  const marks = useRef<IntersectionObserver | null>(null);
  const visible = useRef(new Set<number>());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const flush = () => {
      readTimer.current = null;
      if (isHeavyAnimating()) { onHeavyAnimationEnd(flush); return; }
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let max = 0;
      for (const id of visible.current) if (id > max) max = id;
      if (max) seen(chatId, max);
    };
    const schedule = () => { if (!readTimer.current) readTimer.current = setTimeout(flush, READ_EVERY); };
    marks.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = Number((e.target as HTMLElement).dataset.mid);
        if (e.isIntersecting) visible.current.add(id); else visible.current.delete(id);
      }
      schedule();
    }, { root: el.current, rootMargin: `-${TOP_ZONE}px 0px -80px 0px` });
    addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      marks.current?.disconnect();
      if (readTimer.current) clearTimeout(readTimer.current);
      removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [chatId]);

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
  const onScrollDates = (root: HTMLElement) => {
    if (!scrolling.current) {
      scrolling.current = true;
      requestMutation(() => root.querySelectorAll('.rl-date.stuck').forEach((d) => d.classList.remove('stuck')));
    }
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = setTimeout(() => {
      scrolling.current = false;
      requestMeasure(() => {
        const stickAt = root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop) + 8; // padding ленты + top: 8px у .rl-date
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
    if (programmatic.current > 0) { programmatic.current--; return; } // наша прокрутка не меняет «прижата к низу»
    requestMeasure(() => {
      const fromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      const live = metaRef.current?.live ?? true;
      stick.current = fromBottom < BOTTOM && live;
      setAway(fromBottom > root.clientHeight || !live);
    });
  }

  const toLatest = () => {
    stick.current = true;
    const root = el.current!;
    if (metaRef.current && !metaRef.current.live) { toBottom.current = true; moveWindow('latest'); return; }
    requestMeasure(() => { const top = root.scrollHeight; requestMutation(() => root.scrollTo({ top, behavior: 'smooth' })); });
  };

  // переход к сообщению: строка в окне — плавно к ней (по центру) и подсветить; нет — ждём новое окно
  useLayoutEffect(() => {
    const root = el.current;
    if (!root || !focus || !placed.current) return;
    const row = root.querySelector<HTMLElement>(`.app-msg[data-sort="${focus.sort}"]`);
    if (!row) return;
    setGlobal({ focus: null });
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
        requestMutation(() => root.scrollTo({ top, behavior: 'smooth' }));
      });
    }
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [focus, messages]);

  // клик по цитате — к исходному сообщению
  const onClick = (e: MouseEvent) => {
    const quote = (e.target as Element).closest('.rl-quote');
    const row = quote?.closest<HTMLElement>('.app-msg');
    if (!row) return;
    const m = messages.find((x) => x.key === row.dataset.key);
    const r = m?.reply as Quote | null | undefined;
    if (r) focusMessage({ id: r.id, sort: r.sort });
  };

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
  shown.forEach((m, i) => {
    const day = dayKey(m.createdAt as string);
    const mine = m.senderId === meId;
    if (day !== prevDay) out.push(<DateDivider key={'d' + day}>{dayLabel(m.createdAt as string)}</DateDivider>);
    if (!unreadShown && unreadFrom != null && !mine && m.id != null && (m.id as number) > unreadFrom) {
      unreadShown = true;
      out.push(<div class="app-unread-divider" key="unread" role="separator"><span>Непрочитанные сообщения</span></div>);
    }
    const next = shown[i + 1];
    const start = prevSender !== m.senderId || day !== prevDay;
    const end = !next || next.senderId !== m.senderId || dayKey(next.createdAt as string) !== day;
    const quoted = m.reply as Quote | null;
    out.push(
      <Row
        key={m.key}
        m={m}
        out={mine}
        start={start}
        end={end}
        quoted={quoted}
        quoteAuthor={quoted ? (quoted.senderId === meId ? 'Вы' : peerName) : undefined}
        quoteTone={quoted ? (quoted.senderId === meId ? 1 : 3) : undefined}
        appear={initial.current !== null && !initial.current.has(m.key)}
        flash={flashKey === m.key}
      />,
    );
    prevDay = day; prevSender = m.senderId;
  });
  out.push(<div class="app-sentinel" data-dir="newer" key={'n' + (messages[messages.length - 1]?.key ?? '')} aria-hidden="true" />);

  return (
    <>
      <div class="rl-feed" ref={el} onScroll={onScroll} onClick={onClick} onContextMenu={onContextMenu} aria-live="polite">{out}</div>
      <div class="rl-scrolldown-slot">
        <ScrollToBottom show={away || (meta ? !meta.live : false)} unread={unread} onClick={toLatest} />
      </div>
    </>
  );
}
