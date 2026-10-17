// Дерево страниц боковой панели и навигация по нему. Чистая логика (без DOM) + installNav() для window.

/** Порядок для SlideStack: родитель раньше ребёнка. `:name` — параметр пути. */
export const PAGES = [
  'chats',
  'settings',
  'settings/profile',
  'settings/general',
  'settings/general/wallpaper',
  'settings/notifications',
  'settings/privacy',
  'settings/privacy/rule/:key',
  'settings/privacy/rule/:key/allow',
  'settings/privacy/rule/:key/deny',
  'settings/privacy/blocked',
  'settings/data',
  'settings/data/autoload/:type',
  'settings/performance',
  'settings/sessions',
  'settings/dev',
  'settings/dev/:tab',
  'contacts',
  'contacts/:userId/edit',
];

const ROOT = 'chats';

const matchers = PAGES.map((p) => new RegExp('^' + p.replace(/:[a-zA-Z]+/g, '[^/]+') + '$'));

/** Индекс шаблона в PAGES для конкретного пути (-1 — такой страницы нет). */
export function pageIndex(path: string): number {
  return matchers.findIndex((re) => re.test(path));
}

/** Родитель: отрезаем последний сегмент; составные хвосты (rule/:key, autoload/:type, :id/edit) — целиком. */
const COMPOUND: [RegExp, string][] = [
  [/^(settings\/privacy)\/rule\/[^/]+$/, '$1'],
  [/^(settings\/data)\/autoload\/[^/]+$/, '$1'],
  [/^(contacts)\/[^/]+\/edit$/, '$1'],
];
export function parentOf(path: string): string {
  if (path === ROOT) return ROOT;
  for (const [re, to] of COMPOUND) if (re.test(path)) return path.replace(re, to);
  const i = path.lastIndexOf('/');
  return i < 0 ? ROOT : path.slice(0, i);
}

// последний конкретный путь для каждого шаблона: уходящая страница должна остаться в order
// на время анимации, иначе SlideStack не найдёт её индекс (направление) и не отрисует
const lastConcrete = new Map<number, string>();

/** Порядок страниц с подставленными конкретными путями (SlideStack ищет ключи по строке). */
export function orderFor(active: string): string[] {
  const idx = pageIndex(active);
  if (idx >= 0) lastConcrete.set(idx, active);
  return PAGES.map((p, i) => lastConcrete.get(i) ?? p);
}

// ---------- состояние навигации ----------

interface Binding {
  get: () => string;
  set: (path: string) => void;
  /** Esc сейчас принадлежит чему-то другому (правая панель и т.п.) */
  escBusy?: () => boolean;
}
interface HistoryLike {
  pushState(state: unknown, title: string): void;
  replaceState(state: unknown, title: string): void;
  back(): void;
  state: unknown;
}

let bind: Binding | null = null;
let hist: HistoryLike | null = null;
let stack: string[] = [ROOT];   // путь для каждой записи истории; idx — текущая
let idx = 0;
let guard: (() => boolean | Promise<boolean>) | null = null;

/** Несохранённая форма: guard возвращает false (или промис false) — уход отменяется. */
export function setLeaveGuard(fn: (() => boolean | Promise<boolean>) | null): void { guard = fn; }

const current = () => bind?.get() ?? ROOT;
const stamp = (path: string, i: number) => ({ nav: path, i });

async function canLeave(): Promise<boolean> { return guard ? await guard() : true; }

/** Вглубь (или в соседний раздел): новая запись истории. */
export async function go(path: string): Promise<void> {
  if (!bind || pageIndex(path) < 0 || path === current()) return;
  if (!(await canLeave())) return;
  idx += 1;
  stack = stack.slice(0, idx);
  stack[idx] = path;
  hist?.pushState(stamp(path, idx), '');
  bind.set(path);
}

/** К родителю: если он — предыдущая запись истории, идём history.back(), иначе подменяем текущую запись. */
export async function back(): Promise<void> {
  if (!bind || current() === ROOT) return;
  if (!(await canLeave())) return;
  const parent = parentOf(current());
  if (idx > 0 && stack[idx - 1] === parent) {
    skipGuard = true;
    hist?.back();   // popstate выставит страницу
    if (!hist) { idx -= 1; bind.set(parent); }
    return;
  }
  stack[idx] = parent;
  hist?.replaceState(stamp(parent, idx), '');
  bind.set(parent);
}

let skipGuard = false;

/** Кнопка «Назад» браузера (или программный history.back()). */
async function onPop(state: unknown): Promise<void> {
  if (!bind) return;
  const s = state as { nav?: string; i?: number } | null;
  const target = s?.nav && pageIndex(s.nav) >= 0 ? s.nav : ROOT;
  const i = s?.i ?? 0;
  const mine = skipGuard;
  skipGuard = false;
  if (!mine && !(await canLeave())) {
    // пользователь отказался уходить: возвращаем запись, на которой стояли
    const cur = current();
    if (i < idx) {   // шли назад — запись «вперёд» потеряна, ставим заново поверх
      idx = i + 1;
      stack[idx] = cur;
      hist?.pushState(stamp(cur, idx), '');
    }
    return;
  }
  idx = i;
  stack[i] = target;
  bind.set(target);
}

/** Esc → назад; можно перехватить: preventDefault, открытая модалка/меню, правая панель. */
export function onEscape(e: { key: string; defaultPrevented: boolean }, modalOpen: boolean): void {
  if (e.key !== 'Escape' || e.defaultPrevented || modalOpen || bind?.escBusy?.()) return;
  void back();
}

/** Подключает window: popstate и Esc; первую запись истории помечаем корнем. */
export function installNav(b: Binding, h: HistoryLike = history): () => void {
  bind = b;
  hist = h;
  stack = [ROOT];
  idx = 0;
  h.replaceState(stamp(ROOT, 0), '');
  const pop = (e: PopStateEvent) => { void onPop(e.state); };
  const key = (e: KeyboardEvent) => onEscape(e, !!document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]'));
  addEventListener('popstate', pop);
  addEventListener('keydown', key);
  return () => { removeEventListener('popstate', pop); removeEventListener('keydown', key); bind = null; hist = null; };
}

/** Только для тестов: подключить без window. */
export function bindForTest(b: Binding, h: HistoryLike | null = null): void {
  bind = b; hist = h; stack = [ROOT]; idx = 0; guard = null; skipGuard = false;
}
export const popForTest = onPop;

// ---------- прокрутка страниц ----------
const scrolls = new Map<string, number>();
export const rememberScroll = (path: string, top: number) => { scrolls.set(path, top); };
export const recallScroll = (path: string) => scrolls.get(path) ?? 0;
