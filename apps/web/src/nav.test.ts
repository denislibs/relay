import { beforeEach, expect, test } from 'bun:test';
import { PAGES, back, bindChatDepth, bindForTest, go, onEscape, orderFor, pageIndex, parentOf, popChats, popForTest, pushChat, setLeaveGuard } from './nav';

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

function fake() {
  const entries: { nav: string; i: number; chat?: number }[] = [{ nav: 'chats', i: 0 }];
  let pos = 0, view = 'chats';
  const hist = {
    get state() { return entries[pos]; },
    pushState(s: { nav: string; i: number; chat?: number }) { entries.length = pos + 1; entries.push(s); pos++; },
    replaceState(s: { nav: string; i: number; chat?: number }) { entries[pos] = s; },
    back() { pos--; void popForTest(entries[pos]); },
    go(n: number) { pos += n; void popForTest(entries[pos]); },
  };
  bindForTest({ get: () => view, set: (p) => { view = p; }, escBusy: () => busy }, hist);
  let busy = false;
  return { hist, view: () => view, setBusy: (b: boolean) => { busy = b; }, pos: () => pos };
}

beforeEach(() => setLeaveGuard(null));

test('go/back: стек консистентен, Esc дважды до чатов', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy');
  expect(f.view()).toBe('settings/privacy');
  expect(f.pos()).toBe(2);
  onEscape({ key: 'Escape', defaultPrevented: false }, false);
  await Promise.resolve(); await Promise.resolve();
  expect(f.view()).toBe('settings');
  await back();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
});

test('Esc игнорируется при defaultPrevented, модалке и занятой правой панели', async () => {
  const f = fake();
  await go('settings');
  onEscape({ key: 'Escape', defaultPrevented: true }, false);
  onEscape({ key: 'Escape', defaultPrevented: false }, true);
  f.setBusy(true);
  onEscape({ key: 'Escape', defaultPrevented: false }, false);
  await Promise.resolve();
  expect(f.view()).toBe('settings');
});

test('прыжок через уровень: back идёт к родителю, а не к предыдущей записи', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy/rule/phone/allow');
  await back();
  expect(f.view()).toBe('settings/privacy/rule/phone');
  await back();
  expect(f.view()).toBe('settings/privacy');
});

test('guard отменяет уход', async () => {
  const f = fake();
  await go('settings');
  setLeaveGuard(() => false);
  await back();
  expect(f.view()).toBe('settings');
});

test('popstate without our state (openChat replaceState(null)): stay on the current page and re-stamp the entry', async () => {
  const f = fake();
  await go('settings');
  await go('settings/privacy');
  await popForTest(null);
  expect(f.view()).toBe('settings/privacy');
  expect(f.hist.state).toEqual({ nav: 'settings/privacy', i: 2, chat: 0 });
  await popForTest({ foo: 1 });
  expect(f.view()).toBe('settings/privacy');
  await back();   // дальше история сходится
  expect(f.view()).toBe('settings');
});

test('back() to an entry openChat left without our stamp still lands on the parent; the next back does not leave the app', async () => {
  const f = fake();
  f.hist.replaceState(null as unknown as { nav: string; i: number });   // старый openChat: replaceState(null) на записи чатов
  await go('settings');
  await back();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
  expect(f.hist.state).toEqual({ nav: 'chats', i: 0, chat: 0 });
  await go('settings');
  await back();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
});

// ---------- стек чатов ----------
function chats() {
  const f = fake();
  const depths: number[] = [];
  bindChatDepth((d) => { depths.push(d); });
  return { ...f, depths };
}

test('чат поверх — своя запись истории; «Назад» браузера снимает по одному', async () => {
  const f = chats();
  pushChat(1);
  pushChat(2);
  expect(f.pos()).toBe(2);
  expect(f.hist.state).toEqual({ nav: 'chats', i: 2, chat: 2 });
  f.hist.back();
  await Promise.resolve();
  expect(f.depths).toEqual([1]);
  f.hist.back();
  await Promise.resolve();
  expect(f.depths).toEqual([1, 0]);
  expect(f.view()).toBe('chats');
});

test('popChats отматывает свои записи одним шагом (клик в списке сбрасывает стек)', async () => {
  const f = chats();
  pushChat(1);
  pushChat(2);
  popChats(0);
  await Promise.resolve();
  expect(f.pos()).toBe(0);
  expect(f.depths).toEqual([0]);
  // дальше история как обычно
  await go('settings');
  await back();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(0);
});

test('страница панели поверх чата: popChats не трогает её запись, Esc закрывает страницу, а не чат', async () => {
  const f = chats();
  pushChat(1);
  await go('settings');
  expect(f.hist.state).toEqual({ nav: 'settings', i: 2, chat: 1 });
  onEscape({ key: 'Escape', defaultPrevented: false }, false);
  await Promise.resolve(); await Promise.resolve();
  expect(f.view()).toBe('chats');
  expect(f.pos()).toBe(1);
  // теперь сверху — чат: Esc снимает его
  onEscape({ key: 'Escape', defaultPrevented: false }, false);
  await Promise.resolve();
  expect(f.depths.at(-1)).toBe(0);
  expect(f.pos()).toBe(0);
});

test('запись, отличающаяся только глубиной чатов, не спрашивает guard несохранённой формы', async () => {
  const f = chats();
  pushChat(1);
  setLeaveGuard(() => false);
  f.hist.back();
  await Promise.resolve();
  expect(f.depths).toEqual([0]);
});
