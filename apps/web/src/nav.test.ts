import { beforeEach, expect, test } from 'bun:test';
import { PAGES, back, bindForTest, go, onEscape, orderFor, pageIndex, parentOf, popForTest, setLeaveGuard } from './nav';

const concrete = [
  'chats', 'settings', 'settings/profile', 'settings/general', 'settings/general/wallpaper', 'settings/notifications',
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
  const entries: { nav: string; i: number }[] = [{ nav: 'chats', i: 0 }];
  let pos = 0, view = 'chats';
  const hist = {
    get state() { return entries[pos]; },
    pushState(s: { nav: string; i: number }) { entries.length = pos + 1; entries.push(s); pos++; },
    replaceState(s: { nav: string; i: number }) { entries[pos] = s; },
    back() { pos--; void popForTest(entries[pos]); },
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
  expect(f.hist.state).toEqual({ nav: 'settings/privacy', i: 2 });
  await popForTest({ foo: 1 });
  expect(f.view()).toBe('settings/privacy');
  await back();   // дальше история сходится
  expect(f.view()).toBe('settings');
});
