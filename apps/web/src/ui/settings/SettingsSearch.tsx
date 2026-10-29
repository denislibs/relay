// Поиск по настройкам — слой поверх шапки и содержимого страницы settings (как в Telegram Web K).
// Пустой запрос — «Недавние», иначе выдача по разделам. Сам слой и переход — useSettingsSearch() для Main.tsx.
import { beginHeavyAnimation, EmptyState, Icon, reducedMotion, requestMutation, SearchInput, SettingsIcon, useMinVisible } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getPassword } from '../../authSettings';
import { getGlobal, setGlobal, useGlobal } from '../../global';
import { ENTRIES } from '../../settingsSearch/entries';
import { crumbsFor, searchSettings, topPath, type Entry, type Hit, type SearchCtx } from '../../settingsSearch/match';
import { openSetting } from '../../settingsSearch/navigate';
import { clearSettingsRecent, getSettingsRecent } from '../../settingsSearch/recent';

const SWAP_MS = 150;   // как zoomFade у Telegram и поиск в списке чатов

export function openSettingsSearch(): void { setGlobal({ settingsSearch: { open: true, q: '' } }); }
export function closeSettingsSearch(): void {
  setGlobal({ settingsSearch: { open: false, q: '' } });
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Состояние слоя для страницы settings: классы корня (переход) и сам слой. Переход считается прямо в рендере, где
 * сменился режим, — через эффект первый кадр шёл бы без класса (как в Sidebar.tsx). Возврат с открытым поиском
 * (из пункта выдачи) — сразу слой, без перехода.
 */
export function useSettingsSearch() {
  const open = useGlobal((s) => s.settingsSearch.open);
  const anim = useRef<'in' | 'out' | null>(null);
  const was = useRef(open);
  const [, redraw] = useState(0);
  if (was.current !== open) {
    was.current = open;
    anim.current = reducedMotion() ? null : open ? 'in' : 'out';
  }
  useEffect(() => {
    const a = anim.current;
    if (!a) return;
    const end = beginHeavyAnimation(SWAP_MS);
    const t = setTimeout(() => { if (anim.current === a) { anim.current = null; redraw((n) => n + 1); } end(); }, SWAP_MS);
    return () => { clearTimeout(t); end(); };
  }, [open]);
  // ушли из настроек совсем (не вглубь, к пункту выдачи) — поиск закрывается
  useEffect(() => () => {
    if (!getGlobal().sidebarView.startsWith('settings')) setGlobal({ settingsSearch: { open: false, q: '' } });
  }, []);
  const cls = [open && 'app-ssearching', anim.current && 'app-ssearch-' + anim.current].filter(Boolean).join(' ');
  return {
    open,
    class: cls ? ' ' + cls : '',
    toggle: () => (open ? closeSettingsSearch() : openSettingsSearch()),
    layer: open || anim.current === 'out' ? <div class="app-ss-layer" inert={!open}><SettingsSearch /></div> : null,
  };
}

// облачный пароль: от него зависят пункты «Сменить пароль» / «Установить пароль»; спрашиваем раз за открытие страницы
let pwKnown: boolean | null = null;

function SettingsSearch() {
  const q = useGlobal((s) => s.settingsSearch.q);
  const dev = useGlobal((s) => s.prefs.dev.enabled);
  const [hasPassword, setHasPassword] = useState<boolean | null>(pwKnown);
  useEffect(() => { void getPassword().then((r) => { if (r.ok) setHasPassword(pwKnown = r.data.enabled); }); }, []);
  const ctx: SearchCtx = { dev, hasPassword };
  // недавние — снимок на время показа: новый выбор встаёт наверх, когда поиск откроют снова, порядок не прыгает
  const [recent, setRecent] = useState(getSettingsRecent);
  const groups = useMemo(() => searchSettings(ENTRIES, q, ctx), [q, dev, hasPassword]);
  const recentHits = useMemo(() => recentList(recent, ctx), [recent, dev, hasPassword]);
  const flat = q.trim() ? groups.flatMap((g) => g.items) : recentHits;
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(-1), [q]);
  const list = useRef<HTMLDivElement>(null);

  // Esc вне поля (фокус ушёл со строки ввода) закрывает поиск, а не страницу: раньше обработчика навигации на window.
  // В самом поле Esc — его: сначала стирает запрос, потом закрывает (SearchInput, без записи в историю).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || (e.target as Element | null)?.id === 'settings-search') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      e.preventDefault();
      closeSettingsSearch();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  const none = !!q.trim() && !groups.length;
  const showNone = useMinVisible(none, { delay: 150, min: 0 });

  function move(step: number) {
    if (!flat.length) return;
    const next = active < 0 ? (step > 0 ? 0 : flat.length - 1) : (active + step + flat.length) % flat.length;
    setActive(next);
    requestMutation(() => { list.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' }); });
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
  }
  const pick = (e: Entry) => openSetting(e);

  let i = 0;
  const row = (h: Hit, tile: Entry | null) => {
    const n = i++;
    return <Row key={h.entry.id} n={n} hit={h} tile={tile} active={n === active} onPick={() => pick(h.entry)} />;
  };

  return (
    <div class="app-ss" role="search">
      <div class="app-ss-head">
        <SearchInput
          id="settings-search" back backLabel="Закрыть поиск" onBack={closeSettingsSearch} label="Поиск по настройкам" placeholder="Поиск"
          value={q} autoFocus onChange={(v: string) => setGlobal({ settingsSearch: { open: true, q: v } })}
          onKeyDown={onKeyDown} onEnter={() => { const h = flat[Math.max(0, active)]; if (h) pick(h.entry); }}
          onEscape={closeSettingsSearch}
          inputProps={{ role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'settings-search-list', 'aria-activedescendant': active >= 0 ? 'ss-opt-' + active : undefined }}
        />
      </div>
      <div class="rl-settings app-ss-body" id="settings-search-list" role="listbox" aria-label="Пункты настроек" ref={list}>
        {q.trim() ? (
          groups.map((g) => <Card key={g.section.id}>{g.items.map((h, k) => row(h, k === 0 ? g.section : null))}</Card>)
        ) : recentHits.length ? (
          <Card title="Недавние" action={<button type="button" class="app-gsearch-clear" aria-label="Очистить недавние" onClick={() => { clearSettingsRecent(); setRecent([]); }}><Icon name="close" size={20} /></button>}>
            {recentHits.map((h) => row(h, topSection(h.entry)))}
          </Card>
        ) : null}
        {none && showNone ? <div class="app-ss-none"><EmptyState kind="search" title="Ничего не найдено" text="Попробуйте другое слово или раскладку." /></div> : null}
      </div>
    </div>
  );
}

function Card({ title, action, children }: { title?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="rl-sect app-ss-group">
      {title ? <div class="app-ss-group-head"><h3 class="rl-sect-title">{title}</h3>{action}</div> : null}
      <div class="rl-sect-card">{children}</div>
    </section>
  );
}

function Row({ n, hit, tile, active, onPick }: { n: number; hit: Hit; tile: Entry | null; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button" tabIndex={-1} id={'ss-opt-' + n} data-i={n} role="option" aria-selected={active ? 'true' : 'false'}
      class={'rl-inforow app-ss-row' + (active ? ' is-active' : '')} onClick={onPick}
    >
      {tile?.icon ? <SettingsIcon icon={tile.icon} color={tile.tile} /> : <span class="app-ss-gap" aria-hidden="true" />}
      <span class="rl-inforow-text">
        <span>{marked(hit.entry.title, hit.hits)}</span>
        {hit.crumbs.length ? <small>{hit.crumbs.join(' › ')}</small> : null}
      </span>
    </button>
  );
}

/** Заголовок с подсветкой найденных начал слов (позиции — из match.ts, с ё/е и другой раскладкой). */
function marked(text: string, hits: [number, number][]): ComponentChildren {
  if (!hits.length) return text;
  const out: ComponentChildren[] = [];
  let at = 0;
  for (const [a, b] of hits) {
    out.push(text.slice(at, a), <mark key={a} class="rl-mark">{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

const byId = new Map(ENTRIES.map((e) => [e.id, e]));
const crumbsOf = crumbsFor(ENTRIES);
const topSection = (e: Entry): Entry | null => ENTRIES.find((x) => x.kind === 'section' && x.path === topPath(e.path)) ?? null;

/** Недавние как строки выдачи; пропавшие из индекса и недоступные пункты не показываются. */
function recentList(ids: string[], ctx: SearchCtx): Hit[] {
  return ids.flatMap((id) => {
    const e = byId.get(id);
    return !e || (e.when && !e.when(ctx)) ? [] : [{ entry: e, crumbs: crumbsOf(e), score: 0, hits: [] }];
  });
}
