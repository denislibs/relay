// Дерево страниц боковой панели и навигация по нему. Чистая логика (без DOM) + installNav() для window.
import { createNavStack, type HistoryApi, type NavStack } from './navStack';

/** Порядок для SlideStack: родитель раньше ребёнка. `:name` — параметр пути. */
export const PAGES = [
  'chats',
  'settings',
  'settings/profile',
  'settings/profile/links',
  'settings/profile/links/:item',   // new или номер ссылки
  'settings/general',
  'settings/general/wallpaper',
  'settings/general/wallpaper/color',
  'settings/notifications',
  'settings/privacy',
  'settings/privacy/rule/:key',
  'settings/privacy/rule/:key/allow',
  'settings/privacy/rule/:key/deny',
  'settings/privacy/blocked',
  'settings/privacy/password',
  'settings/privacy/passkeys',
  'settings/data',
  'settings/data/autoload/:type',
  'settings/performance',
  'settings/sessions',
  'settings/folders',
  'settings/folders/:id',          // new или id папки
  'settings/folders/:id/include',  // выбор чатов и типов для включённых
  'settings/folders/:id/exclude',  // и для исключённых
  'settings/dev',   // вкладка раздела — devTab в global, не путь
  'archive',   // архивные чаты (строка «Архив» над «Все»)
  'contacts',
  'contacts/:userId/edit',
  'newGroup',        // новая группа: выбор участников
  'newGroup/name',   // и название
  'newChannel',         // новый канал: название, описание, фото
  'newChannel/members', // и подписчики (можно пропустить)
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
// Каждый открытый слой — своя запись стека navStack (и истории браузера): страницы левой колонки, чаты поверх чата,
// правая панель. «Назад» закрывает ровно свой слой: стрелка в «Контактах» закрывает контакты, а открытый из них чат остаётся.

interface Binding {
  get: () => string;
  set: (path: string) => void;
  /** Esc сейчас принадлежит чему-то другому (правая панель и т.п.) */
  escBusy?: () => boolean;
}

let bind: Binding | null = null;
let stack: NavStack | null = null;
let guard: (() => boolean | Promise<boolean>) | null = null;

/** Несохранённая форма: guard возвращает false (или промис false) — уход отменяется. */
export function setLeaveGuard(fn: (() => boolean | Promise<boolean>) | null): void { guard = fn; }

const current = () => bind?.get() ?? ROOT;
async function canLeave(): Promise<boolean> { return guard ? await guard() : true; }

/** Путь, который показывает левая колонка при текущих открытых записях страниц. */
const shownPath = () => stack?.open('page').at(-1)?.key ?? ROOT;
const pageBack = () => { if (bind && current() !== shownPath()) bind.set(shownPath()); };

/** Вглубь (или в соседний раздел): новая запись истории. */
export async function go(path: string): Promise<void> {
  if (!bind || !stack || pageIndex(path) < 0 || path === current()) return;
  if (!(await canLeave())) return;
  if (path === ROOT) { closePages(); return; }
  stack.push('page', pageBack, { key: path });
  bind.set(path);
}

function closePages() {
  stack?.closeAll('page');
  bind?.set(ROOT);
}

/** К родителю: если он — страница под текущей, закрываем запись текущей, иначе подменяем путь у её записи. */
export async function back(): Promise<void> {
  if (!bind || !stack || current() === ROOT) return;
  if (!(await canLeave())) return;
  const cur = current(), parent = parentOf(cur);
  const pages = stack.open('page');
  const top = pages.at(-1);
  if (parent === ROOT) { closePages(); return; }   // к списку чатов — все страницы закрыты
  if (top && top.key === cur && (pages.at(-2)?.key ?? ROOT) === parent) { stack.closeType('page'); return; }
  if (top) top.key = parent;   // прыжок через уровень (или страница без записи): та же запись, путь — родитель
  bind.set(parent);
}

/** Сразу к списку чатов (например, после создания группы): все страницы панели закрываются, чаты не трогаются. */
export async function home(): Promise<void> {
  if (!bind || current() === ROOT) return;
  closePages();
}

// ---------- слои поверх: чаты, правая панель ----------

/** Открыть слой (чат поверх чата, правая панель): своя запись истории; onBack — «Назад» браузера или Esc. */
export function pushLayer(type: 'chat' | 'info', onBack: () => void, key?: string): number {
  return stack ? stack.push(type, onBack, { key }) : 0;
}
/** Слой закрыли из интерфейса — убрать его запись (onBack не вызывается). */
export function closeLayer(id: number): void { stack?.close(id); }
/** Закрыть все слои типа из интерфейса (сменился нижний чат — верхние уже сняты). */
export function closeLayers(type: 'chat' | 'info'): void { stack?.closeAll(type); }

/** Esc → верхний открытый слой; можно перехватить: preventDefault, открытая модалка/меню, правая панель. */
export function onEscape(e: { key: string; defaultPrevented: boolean }, modalOpen: boolean): void {
  if (e.key !== 'Escape' || e.defaultPrevented || modalOpen || bind?.escBusy?.()) return;
  const top = stack?.topOpen();
  if (top && top.type !== 'page' && top.type !== 'root') { stack!.closeType(top.type); return; }
  void back();
}

function create(b: Binding, h: HistoryApi): NavStack {
  bind = b;
  guard = null;
  // «Назад» браузера снимает страницу с несохранённой формой — спросить; слои чатов и панели форму не трогают
  stack = createNavStack(h, { canPop: (popping) => !popping.some((e) => e.type === 'page') || canLeave() });
  return stack;
}

/** Подключает window: popstate и Esc; первую запись истории помечаем корнем. */
export function installNav(b: Binding, h: HistoryApi = history): () => void {
  const s = create(b, h);
  const pop = (e: PopStateEvent) => { void s.onPop(e.state); };
  const key = (e: KeyboardEvent) => onEscape(e, !!document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]'));
  addEventListener('popstate', pop);
  addEventListener('keydown', key);
  return () => { removeEventListener('popstate', pop); removeEventListener('keydown', key); bind = null; stack = null; };
}

/** Только для тестов: подключить без window; popstate подаётся через возвращённый стек (onPop). */
export const bindForTest = create;
/** Для тестов и отладки: записи стека. */
export const navSnapshot = () => stack?.snapshot() ?? [];

// ---------- прокрутка страниц ----------
const scrolls = new Map<string, number>();
export const rememberScroll = (path: string, top: number) => { scrolls.set(path, top); };
export const recallScroll = (path: string) => scrolls.get(path) ?? 0;
