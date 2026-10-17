import { Button, Chip, IconButton, Presence, SearchField, WindowList, requestMeasure, requestMutation } from '@relay/ui';
import type { Item } from '@relay/sync-engine/src/types';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useDevLog } from '../../devtools/session';
import { showToast } from '../../settingsData';
import { stamp } from './devui';

const ROW = 28;
type Kind = 'ws-out' | 'ws-in' | 'engine' | 'error';
const KINDS: [Kind | 'all', string][] = [['all', 'Все'], ['ws-out', '↑ Исходящие'], ['ws-in', '↓ Входящие'], ['engine', 'Движок'], ['error', 'Ошибки']];
const DIR: Record<Kind, string> = { 'ws-out': '↑', 'ws-in': '↓', engine: '•', error: '!' };
const TOP_TYPES = 10;

// краткая сводка события (JSON одной строкой) — считаем один раз на событие
const brief = new Map<string, string>();
function summary(e: Item): string {
  let s = brief.get(e.key);
  if (s === undefined) {
    const d = e.data as Record<string, unknown> | null;
    s = d ? JSON.stringify(d.op === e.type ? { ...d, op: undefined } : d) : '';
    if (s === '{}') s = '';
    if (s.length > 120) s = s.slice(0, 120) + '…';
    if (brief.size > 4000) brief.clear();
    brief.set(e.key, s);
  }
  return s;
}

/** «Журнал»: живой лог движка, новые снизу; автопрокрутка встаёт, если пролистать вверх. */
export function DevLog() {
  const { list } = useDevLog();
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [type, setType] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState<Item[] | null>(null);
  const [cleared, setCleared] = useState(0);
  const [sel, setSel] = useState<Item | null>(null);
  const lastSel = useRef<Item | null>(null);
  if (sel) lastSel.current = sel;
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [fresh, setFresh] = useState(0);

  const source = paused ?? list;
  const types = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of source) if ((e.id as number) > cleared) c.set(e.type as string, (c.get(e.type as string) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TYPES).map(([t]) => t);
  }, [source, cleared]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => source.filter((e) =>
    (e.id as number) > cleared && (kind === 'all' || e.kind === kind) && (!type || e.type === type) &&
    (!q || (e.type as string).toLowerCase().includes(q) || summary(e).toLowerCase().includes(q))), [source, cleared, kind, type, q]);

  // новые строки: прилипли к низу — прокрутить вниз (запись без чтения: браузер сам упрёт scrollTop в край), иначе считать «Новые»
  const prevLen = useRef(0);
  useLayoutEffect(() => {
    const delta = rows.length - prevLen.current;
    prevLen.current = rows.length;
    if (stuck.current) requestMutation(() => { const el = scroller.current; if (el) el.scrollTop = rows.length * ROW + 10_000; });
    else if (delta > 0) setFresh((n) => n + delta);
  }, [rows.length]);

  const onScroll = () => {
    requestMeasure(() => {
      const el = scroller.current;
      if (!el) return;
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < ROW / 2;
      stuck.current = atEnd;
      if (atEnd) requestMutation(() => setFresh(0));
    });
  };
  const toEnd = () => { stuck.current = true; setFresh(0); requestMutation(() => { const el = scroller.current; if (el) el.scrollTop = rows.length * ROW + 10_000; }); };

  const copy = () => {
    const text = JSON.stringify(rows.map(({ key: _k, ...e }) => e), null, 2);
    navigator.clipboard?.writeText(text).then(() => showToast(`Скопировано событий: ${rows.length}`), () => showToast('Буфер обмена недоступен'));
  };
  const clear = () => { const last = list.length ? (list[list.length - 1].id as number) : 0; setCleared(last); setPaused(null); setSel(null); setFresh(0); stuck.current = true; };

  const shown = sel ?? lastSel.current;
  return (
    <div class="app-dev-log">
      <div class="app-dev-logtools">
        <SearchField id="dev-log-search" label="Поиск по журналу" placeholder="Поиск: тип или данные" value={query} onInput={(e: Event) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <div class="rl-chips app-dev-chips" role="group" aria-label="Тип события">
          {KINDS.map(([k, label]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{label}</Chip>)}
        </div>
        <div class="rl-chips app-dev-chips" role="group" aria-label="Кадр">
          {types.map((t) => <Chip key={t} active={type === t} onClick={() => setType(type === t ? null : t)}>{t}</Chip>)}
        </div>
        <div class="app-dev-actions">
          <Button variant="secondary" onClick={() => setPaused(paused ? null : list.slice())}>{paused ? 'Продолжить' : 'Пауза'}</Button>
          <Button variant="secondary" onClick={clear}>Очистить</Button>
          <Button variant="secondary" onClick={copy}>Скопировать как JSON</Button>
          <span class="app-dev-count">{rows.length}</span>
        </div>
      </div>
      <div class="app-dev-logscroll" ref={scroller} onScroll={onScroll} role="log" aria-live="off" aria-label="Журнал событий">
        {rows.length ? (
          <WindowList items={rows} rowHeight={ROW} overscan={10} getKey={(e: Item) => e.key} render={(e: Item) => (
            <button type="button" class={'app-dev-ev app-dev-ev-' + e.kind + (sel?.key === e.key ? ' app-dev-ev-on' : '')} onClick={() => setSel(sel?.key === e.key ? null : e)}>
              <span class="app-dev-ev-t">{stamp(e.t as number)}</span>
              <span class="app-dev-ev-d" aria-label={e.kind as string}>{DIR[e.kind as Kind]}</span>
              <span class="app-dev-ev-type">{e.type as string}</span>
              <span class="app-dev-ev-sum">{summary(e)}</span>
              <span class="app-dev-ev-n">{e.size != null ? `${e.size} Б` : ''}</span>
              <span class="app-dev-ev-n">{e.ms != null ? `${e.ms} мс` : ''}</span>
            </button>
          )} />
        ) : <p class="app-dev-empty">{paused ? 'Журнал на паузе' : 'Событий пока нет'}</p>}
      </div>
      <Presence show={fresh > 0} exitMs={160}>
        <button type="button" class="app-dev-fresh" onClick={toEnd}>↓ Новые: {fresh}</button>
      </Presence>
      <Presence show={!!sel} exitMs={200}>
        <div class="app-dev-detail">
          <div class="app-dev-detail-head">
            <b>{shown ? `#${shown.id} · ${shown.type}` : ''}</b>
            <IconButton icon="close" label="Закрыть" onClick={() => setSel(null)} />
          </div>
          <pre>{shown ? JSON.stringify((({ key: _k, ...e }) => e)(shown), null, 2) : ''}</pre>
        </div>
      </Presence>
    </div>
  );
}
