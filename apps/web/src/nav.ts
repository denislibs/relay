// Дерево страниц боковой панели и навигация по нему. Чистая логика (без DOM) + installNav() для window.

/** Порядок для SlideStack: родитель раньше ребёнка. `:name` — параметр пути. */
export const PAGES = [
  'chats',
  'settings',
  'settings/profile',
  'settings/profile/links',
  'settings/profile/links/:item',   // new или номер ссылки
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
  'settings/dev',   // вкладка раздела — devTab в global, не путь
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
  go?(delta: number): void;
  state: unknown;
}

let bind: Binding | null = null;
let hist: HistoryLike | null = null;
let stack: string[] = [ROOT];   // путь для каждой записи истории; idx — текущая
let layers: number[] = [0];     // глубина стека чатов на каждой записи (0 — только нижний чат)
let idx = 0;
// стек чатов (data.ts): запись истории сменила глубину — привести стек к ней
let chatDepth: ((depth: number) => void) | null = null;
export function bindChatDepth(fn: ((depth: number) => void) | null): void { chatDepth = fn; }
let guard: (() => boolean | Promise<boolean>) | null = null;

/** Несохранённая форма: guard возвращает false (или промис false) — уход отменяется. */
export function setLeaveGuard(fn: (() => boolean | Promise<boolean>) | null): void { guard = fn; }

const current = () => bind?.get() ?? ROOT;
const stamp = (path: string, i: number) => ({ nav: path, i, chat: layers[i] ?? 0 });

/**
 * Чат открыт поверх другого (как setInnerPeer в Telegram): своя запись истории — «Назад» браузера снимает его.
 * depth — новая глубина стека чатов.
 */
export function pushChat(depth: number): void {
  if (!bind) return;
  idx += 1;
  stack = stack.slice(0, idx);
  layers = layers.slice(0, idx);
  stack[idx] = current();
  layers[idx] = depth;
  hist?.pushState(stamp(current(), idx), '');
}

/**
 * Стек чатов сократили сами (кнопка «Назад», Esc, клик в списке): если сверху лежат наши записи чатов —
 * отматываем историю на них, иначе (поверх уже страницы панели) просто помечаем текущую запись новой глубиной.
 */
export function popChats(to: number): void {
  if (!bind || (layers[idx] ?? 0) <= to) return;
  let k = 0;
  while (idx - k > 0 && layers[idx - k] > to && stack[idx - k - 1] === stack[idx] && layers[idx - k - 1] === layers[idx - k] - 1) k++;
  if (k > 0 && layers[idx - k] === to && hist?.go) {
    skipChat = true;
    idx -= k;
    hist.go(-k);   // popstate придёт на запись с глубиной to — стек уже такой
    return;
  }
  layers[idx] = to;
  hist?.replaceState(stamp(current(), idx), '');
}
let skipChat = false;

/** Верхняя запись истории — открытие чата поверх (а не страница панели): Esc закрывает его. */
export const chatOnTop = () => idx > 0 && (layers[idx] ?? 0) > (layers[idx - 1] ?? 0) && stack[idx - 1] === stack[idx];

async function canLeave(): Promise<boolean> { return guard ? await guard() : true; }

/** Вглубь (или в соседний раздел): новая запись истории. */
export async function go(path: string): Promise<void> {
  if (!bind || pageIndex(path) < 0 || path === current()) return;
  if (!(await canLeave())) return;
  idx += 1;
  stack = stack.slice(0, idx);
  layers = layers.slice(0, idx);
  stack[idx] = path;
  layers[idx] = layers[idx - 1] ?? 0;   // страница панели не меняет стек чатов
  hist?.pushState(stamp(path, idx), '');
  bind.set(path);
}

/** К родителю: если он — предыдущая запись истории, идём history.back(), иначе подменяем текущую запись. */
export async function back(): Promise<void> {
  if (!bind || current() === ROOT) return;
  if (!(await canLeave())) return;
  const parent = parentOf(current());
  if (idx > 0 && stack[idx - 1] === parent && layers[idx - 1] === layers[idx]) {
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
  // запись без нашей отметки (data.ts openChat делает replaceState(null) под #chat=…): остаёмся где были
  // и помечаем запись текущим путём, чтобы следующие переходы по истории сходились со stack
  if (!s || typeof s.nav !== 'string' || typeof s.i !== 'number') {
    const mine = skipGuard;
    skipGuard = false;
    // наш back() шёл к родителю (stack[idx - 1]): доходим до него, иначе экран стоит, а браузер уже на запись назад,
    // и следующий «Назад» уводит из приложения
    if (mine && idx > 0) {
      idx -= 1;
      hist?.replaceState(stamp(stack[idx], idx), '');
      bind.set(stack[idx]);
      return;
    }
    hist?.replaceState(stamp(current(), idx), '');
    return;
  }
  const target = pageIndex(s.nav) >= 0 ? s.nav : ROOT;
  const i = s.i;
  const depth = typeof (s as { chat?: unknown }).chat === 'number' ? (s as { chat: number }).chat : 0;
  if (skipChat) {   // наш popChats: стек чатов уже сокращён, страница панели та же
    skipChat = false;
    idx = i; layers[i] = depth; stack[i] = target;
    chatDepth?.(depth);
    return;
  }
  // запись отличается только глубиной чатов (та же страница панели) — несохранённой формы это не касается
  if (target === current() && i !== idx) {
    idx = i; stack[i] = target; layers[i] = depth;
    chatDepth?.(depth);
    return;
  }
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
  layers[i] = depth;
  bind.set(target);
  chatDepth?.(depth);
}

/** Esc → назад; можно перехватить: preventDefault, открытая модалка/меню, правая панель. */
export function onEscape(e: { key: string; defaultPrevented: boolean }, modalOpen: boolean): void {
  if (e.key !== 'Escape' || e.defaultPrevented || modalOpen || bind?.escBusy?.()) return;
  // последним открыли чат поверх — Esc закрывает его (как «Назад»), а не страницу панели
  if (chatOnTop()) { popChats(layers[idx] - 1); chatDepth?.(layers[idx]); return; }
  void back();
}

/** Подключает window: popstate и Esc; первую запись истории помечаем корнем. */
export function installNav(b: Binding, h: HistoryLike = history): () => void {
  bind = b;
  hist = h;
  stack = [ROOT];
  layers = [0];
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
  bind = b; hist = h; stack = [ROOT]; layers = [0]; idx = 0; guard = null; skipGuard = false; skipChat = false; chatDepth = null;
}
export const popForTest = onPop;

// ---------- прокрутка страниц ----------
const scrolls = new Map<string, number>();
export const rememberScroll = (path: string, top: number) => { scrolls.set(path, top); };
export const recallScroll = (path: string) => scrolls.get(path) ?? 0;
