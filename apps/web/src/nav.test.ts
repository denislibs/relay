import { beforeEach, expect, test } from 'bun:test';
import { PAGES, back, bindForTest, closeLayer, closeLayers, go, home, navSnapshot, onEscape, orderFor, pageIndex, parentOf, pushLayer, setLeaveGuard } from './nav';

const concrete = [
  'chats', 'settings', 'settings/profile', 'settings/profile/links', 'settings/profile/links/new', 'settings/general', 'settings/general/wallpaper', 'settings/notifications',
  'settings/privacy', 'settings/privacy/rule/lastSeen', 'settings/privacy/rule/lastSeen/allow', 'settings/privacy/rule/phone/deny',
  'settings/privacy/blocked', 'settings/data', 'settings/data/autoload/photo', 'settings/performance', 'settings/sessions',
  'settings/dev', 'contacts', 'contacts/42/edit',
];

test('parentOf', () => {
  expect(parentOf('settings/privacy/rule/lastSeen/allow')).toBe('settings/privacy/rule/lastSeen');
  expect(parentOf('settings/privacy/rule/lastSeen')).toBe('settings/privacy');
  expect(parentOf('settings/data/autoload/photo')).toBe('settings/data');
  expect(parentOf('contacts/42/edit')).toBe('contacts');
  expect(pageIndex('settings/dev/log')).toBe(-1);   // вкладки раздела — не пути
  expect(parentOf('settings/general/wallpaper')).toBe('settings/general');
  expect(parentOf('settings')).toBe('chats');
  expect(parentOf('contacts')).toBe('chats');
  expect(parentOf('chats')).toBe('chats');
});

test('индекс ребёнка больше индекса родителя', () => {
  for (const p of concrete) {
    expect(pageIndex(p)).toBeGreaterThanOrEqual(0);
    if (p !== 'chats') expect(pageIndex(p)).toBeGreaterThan(pageIndex(parentOf(p)));
  }
  for (const p of PAGES) expect(pageIndex(p.replace(/:[a-zA-Z]+/g, 'x'))).toBe(PAGES.indexOf(p));
});

test('orderFor подставляет конкретный путь на место шаблона', () => {
  const o = orderFor('settings/privacy/rule/lastSeen/allow');
  expect(o.length).toBe(PAGES.length);
  expect(o[PAGES.indexOf('settings/privacy/rule/:key/allow')]).toBe('settings/privacy/rule/lastSeen/allow');
  // уходящий конкретный путь остаётся в order (анимация назад), пока его место не займёт другой
  const back1 = orderFor('settings/privacy');
  expect(back1[PAGES.indexOf('settings/privacy/rule/:key/allow')]).toBe('settings/privacy/rule/lastSeen/allow');
  expect(back1.indexOf('settings/privacy')).toBe(PAGES.indexOf('settings/privacy'));
  expect(pageIndex('nope/x')).toBe(-1);
});

/** Подделка истории: go() асинхронный, как в браузере; userBack — «Назад» браузера. */
function fake() {
  const list: unknown[] = [null];
  let pos = 0, view = 'chats', busy = false;
  const hist = {
    get state() { return list[pos]; },
    pushState(s: unknown) { list.length = pos + 1; list.push(s); pos++; },
    replaceState(s: unknown) { list[pos] = s; },
    go(n: number) { setTimeout(() => { pos = Math.max(0, pos + n); void stack.onPop(list[pos]); }, 0); },
  };
  let mode = false;   // фоновый режим (выбор чатов): Esc снимает его раньше навигации
  const stack = bindForTest({ get: () => view, set: (p) => { view = p; }, escBusy: () => busy, escMode: () => { if (!mode) return false; mode = false; return true; } }, hist);
  const log: string[] = [];
  return {
    view: () => view, pos: () => pos, setBusy: (b: boolean) => { busy = b; }, log,
    setMode: (m: boolean) => { mode = m; }, mode: () => mode,
    async userBack(n = 1) { pos -= n; await stack.onPop(list[pos]); await settle(); },
    chat: (key: string) => pushLayer('chat', () => log.push('close ' + key), key),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const esc = async () => { onEscape({ key: 'Escape', defaultPrevented: false }, false); await settle(); };

beforeEach(() => setLeaveGuard(null));

test('go/back: Esc и стрелка — по одной странице до чатов, история сходится', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy');
  expect(f.view()).toBe('settings/privacy');
  expect(f.pos()).toBe(2);
  await esc();
  expect(f.view()).toBe('settings');
  expect(f.pos()).toBe(1);
  await back();
  await settle();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
});

test('браузерный «Назад» по страницам', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy');
  await f.userBack();
  expect(f.view()).toBe('settings');
  await f.userBack();
  expect(f.view()).toBe('chats');
  expect(navSnapshot()).toEqual(['root']);
});

test('Esc игнорируется при defaultPrevented, модалке и занятой правой панели', async () => {
  const f = fake();
  await go('settings');
  onEscape({ key: 'Escape', defaultPrevented: true }, false);
  onEscape({ key: 'Escape', defaultPrevented: false }, true);
  f.setBusy(true);
  await esc();
  expect(f.view()).toBe('settings');
});

test('прямой переход (пункт из поиска по настройкам): «Назад» — к странице, откуда пришли, а не к родителю', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy/rule/phone', { direct: true });
  await go('settings/privacy/rule/phone/allow');
  await back();
  expect(f.view()).toBe('settings/privacy/rule/phone');
  await back();
  await settle();
  expect(f.view()).toBe('settings');
  expect(f.pos()).toBe(1);
  // и браузерный «Назад» — туда же
  await go('settings/general/wallpaper', { direct: true });
  await f.userBack();
  expect(f.view()).toBe('settings');
  // обычный переход по тому же пути снова идёт к родителю
  await go('settings/privacy/rule/phone/allow');
  await back();
  expect(f.view()).toBe('settings/privacy/rule/phone');
});

test('прыжок через уровень: back идёт к родителю, а не к предыдущей записи', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy/rule/phone/allow');
  await back();
  expect(f.view()).toBe('settings/privacy/rule/phone');
  expect(f.pos()).toBe(2);   // та же запись, путь подменён
  await back();
  expect(f.view()).toBe('settings/privacy');
  await f.userBack();        // запись прыжка (сейчас settings/privacy) — назад к settings
  expect(f.view()).toBe('settings');
});

test('guard отменяет уход стрелкой и браузерным «Назад»', async () => {
  const f = fake();
  await go('settings');
  await go('settings/profile');
  setLeaveGuard(() => false);
  await back();
  expect(f.view()).toBe('settings/profile');
  await f.userBack();
  expect(f.view()).toBe('settings/profile');
  expect(f.pos()).toBe(2);   // запись вернулась
  setLeaveGuard(() => true);
  await f.userBack();
  expect(f.view()).toBe('settings');
});

test('home: все страницы закрываются одной операцией', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy');
  await home();
  expect(f.view()).toBe('chats');
  await settle();
  expect(f.pos()).toBe(0);
});

// ---------- слои: чаты поверх, правая панель ----------

test('Контакты → чат поверх → «Назад» в контактах закрывает только контакты; браузерный «Назад» — чат, без лишнего шага', async () => {
  const f = fake();
  await go('contacts');
  f.chat('c1');
  await back();                 // стрелка в шапке контактов
  await settle();
  expect(f.view()).toBe('chats');
  expect(f.log).toEqual([]);   // чат на месте
  expect(f.pos()).toBe(2);
  await f.userBack();
  expect(f.log).toEqual(['close c1']);
  expect(f.pos()).toBe(0);     // «дырка» контактов снята тем же шагом
  expect(navSnapshot()).toEqual(['root']);
});

test('Esc закрывает верхний слой: чат поверх страницы, затем страницу', async () => {
  const f = fake();
  await go('settings');
  f.chat('c1');
  await esc();
  expect(f.log).toEqual(['close c1']);
  expect(f.view()).toBe('settings');
  await esc();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
});

test('страница поверх чата: Esc закрывает страницу, затем чат', async () => {
  const f = fake();
  f.chat('c1');
  await go('settings');
  await esc();
  expect(f.view()).toBe('chats');
  expect(f.log).toEqual([]);
  await esc();
  expect(f.log).toEqual(['close c1']);
  expect(f.pos()).toBe(0);
});

test('чат, закрытый из интерфейса, снимает свою запись; закрытие всех чатов — одной операцией', async () => {
  const f = fake();
  const a = f.chat('c1');
  f.chat('c2');
  f.chat('c3');
  closeLayer(a);               // из середины — верхние живы
  await settle();
  expect(f.pos()).toBe(3);
  closeLayers('chat');
  await settle();
  expect(f.pos()).toBe(0);
  expect(f.log).toEqual([]);
});

test('слой чата при guard: «Назад» браузера закрывает чат, не спрашивая форму', async () => {
  const f = fake();
  await go('settings');
  await go('settings/profile');
  f.chat('c1');
  setLeaveGuard(() => false);
  await f.userBack();
  expect(f.log).toEqual(['close c1']);
  expect(f.view()).toBe('settings/profile');
});

test('правая панель: «Назад» браузера закрывает её', async () => {
  const f = fake();
  let info = true;
  const id = pushLayer('info', () => { info = false; });
  expect(id).toBeGreaterThan(0);
  await f.userBack();
  expect(info).toBe(false);
  expect(f.pos()).toBe(0);
});

test('Esc: выбор чатов снимается раньше «Назад» и закрытия чата, но после модалки и правой панели', async () => {
  const f = fake();
  await go('archive');
  f.chat('a');
  f.setMode(true);
  // модалка или правая панель — Esc их, режим остаётся
  onEscape({ key: 'Escape', defaultPrevented: false }, true);
  f.setBusy(true);
  await esc();
  expect(f.mode()).toBe(true);
  f.setBusy(false);
  // слой переднего плана уже взял Esc (preventDefault) — режим остаётся
  onEscape({ key: 'Escape', defaultPrevented: true }, false);
  expect(f.mode()).toBe(true);
  // первый Esc — только режим: чат открыт, страница та же
  let prevented = false;
  onEscape({ key: 'Escape', defaultPrevented: false, preventDefault: () => { prevented = true; } }, false);
  await settle();
  expect(f.mode()).toBe(false);
  expect(prevented).toBe(true);
  expect(f.log).toEqual([]);
  expect(f.view()).toBe('archive');
  // следующий — обычная навигация: закрыть чат
  await esc();
  expect(f.log).toEqual(['close a']);
  expect(f.view()).toBe('archive');
});
