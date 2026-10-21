import { describe, expect, test } from 'bun:test';
import { createNavStack, type HistoryApi } from './navStack';

/** Подделка истории браузера: go() асинхронный (popstate в следующей задаче), как в настоящем браузере. */
function fakeHistory(initial: unknown = null) {
  const list: unknown[] = [initial];
  let idx = 0;
  let onPop: (s: unknown) => void | Promise<void> = () => {};
  const h: HistoryApi & { list: unknown[]; idx: () => number; userBack(n?: number): Promise<void>; userForward(): Promise<void>; listen(f: typeof onPop): void } = {
    list,
    idx: () => idx,
    get state() { return list[idx]; },
    pushState(s) { list.splice(idx + 1); list.push(s); idx++; },
    replaceState(s) { list[idx] = s; },
    go(d) {
      const to = Math.max(0, Math.min(list.length - 1, idx + d));
      setTimeout(() => { idx = to; void onPop(list[idx]); }, 0);
    },
    async userBack(n = 1) { idx = Math.max(0, idx - n); await onPop(list[idx]); await settle(); },
    async userForward() { idx = Math.min(list.length - 1, idx + 1); await onPop(list[idx]); await settle(); },
    listen(f) { onPop = f; },
  };
  return h;
}
const settle = () => new Promise((r) => setTimeout(r, 5));

function setup(initial: unknown = null, opts = {}) {
  const h = fakeHistory(initial);
  const nav = createNavStack(h, opts);
  h.listen((s) => nav.onPop(s));
  const log: string[] = [];
  const layer = (type: 'page' | 'chat' | 'info', key: string, o = {}) => nav.push(type, () => log.push('back ' + key), { key, ...o });
  return { h, nav, log, layer };
}

describe('navStack', () => {
  test('push и браузерный «Назад» по одному', async () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'settings');
    layer('page', 'settings/privacy');
    expect(h.list.length).toBe(3);
    await h.userBack();
    expect(log).toEqual(['back settings/privacy']);
    expect(nav.snapshot()).toEqual(['root', 'page:settings']);
    await h.userBack();
    expect(log).toEqual(['back settings/privacy', 'back settings']);
    expect(nav.snapshot()).toEqual(['root']);
  });

  test('закрытие верхнего слоя из интерфейса снимает запись истории без onBack', async () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'a');
    const b = layer('chat', 'b');
    nav.close(b);
    await settle();
    expect(log).toEqual([]);
    expect(h.idx()).toBe(1);
    expect(nav.snapshot()).toEqual(['root', 'page:a']);
  });

  test('закрытие из середины не трогает верхние слои; «дырка» снимается, когда до неё доходит «Назад»', async () => {
    const { h, nav, log, layer } = setup();
    const contacts = layer('page', 'contacts');
    layer('chat', 'c1');
    nav.close(contacts);
    await settle();
    expect(h.idx()).toBe(2);   // история не тронута
    expect(nav.snapshot()).toEqual(['root', '(page:contacts)', 'chat:c1']);
    await h.userBack();         // «Назад» закрывает чат и проскакивает «дырку» контактов
    expect(log).toEqual(['back c1']);
    expect(h.idx()).toBe(0);
    expect(nav.snapshot()).toEqual(['root']);
  });

  test('несколько закрытых сверху снимаются одним go(-n)', async () => {
    const { h, nav, layer } = setup();
    const a = layer('page', 'a');
    const b = layer('chat', 'b');
    const c = layer('info', 'c');
    let gos = 0;
    const go = h.go.bind(h);
    h.go = (d) => { gos++; go(d); };
    nav.close(a);
    nav.close(b);
    nav.close(c);
    await settle();
    expect(gos).toBe(1);
    expect(h.idx()).toBe(0);
    expect(nav.snapshot()).toEqual(['root']);
  });

  test('closeType закрывает последний открытый слой типа, где бы он ни лежал', async () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'contacts');
    layer('chat', 'c1');
    expect(nav.closeType('page')).toBe(true);
    await settle();
    expect(log).toEqual(['back contacts']);
    expect(nav.snapshot()).toEqual(['root', '(page:contacts)', 'chat:c1']);
    expect(h.idx()).toBe(2);
    expect(nav.closeType('page')).toBe(false);
    expect(nav.closeType('chat')).toBe(true);
    await settle();
    expect(h.idx()).toBe(0);
    expect(nav.snapshot()).toEqual(['root']);
  });

  test('«Назад» браузера через несколько записей — onBack сверху вниз', async () => {
    const { h, log, layer } = setup();
    layer('page', 'a');
    layer('page', 'b');
    layer('chat', 'c');
    await h.userBack(3);
    expect(log).toEqual(['back c', 'back b', 'back a']);
  });

  test('replace заменяет верхнюю запись без новой записи истории', () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'a');
    layer('page', 'b', { replace: true });
    expect(h.list.length).toBe(2);
    expect(log).toEqual([]);
    expect(nav.snapshot()).toEqual(['root', 'page:b']);
  });

  test('операции во время своего go() ждут popstate', async () => {
    const { h, nav, layer } = setup();
    const a = layer('page', 'a');
    nav.close(a);                 // go(-1) в пути
    expect(nav.pending()).toBe(true);
    layer('page', 'b');           // pushState должен подождать, иначе go(-1) снимет новую запись
    expect(h.list.length).toBe(2);
    await settle();
    expect(nav.pending()).toBe(false);
    expect(h.idx()).toBe(1);
    expect(nav.snapshot()).toEqual(['root', 'page:b']);
    expect((h.state as { i: number }).i).toBe(1);
  });

  test('запись прошлой загрузки: всё открытое закрывается, позиция становится корнем', async () => {
    const { h, nav, log, layer } = setup();
    h.pushState({ sid: 1, i: 5 }, '');    // как будто осталось от прошлой сессии — сначала она
    layer('page', 'a');
    await h.userBack();
    expect(log).toEqual(['back a']);
    expect(nav.snapshot()).toEqual(['root']);
    expect((h.state as { i: number }).i).toBe(0);
    layer('page', 'x');                   // дальше работаем как обычно
    await h.userBack();
    expect(log).toEqual(['back a', 'back x']);
  });

  test('«вперёд» откатывается назад', async () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'a');
    await h.userBack();
    expect(nav.snapshot()).toEqual(['root']);
    await h.userForward();
    await settle();
    expect(h.idx()).toBe(0);
    expect(log).toEqual(['back a']);
    expect(nav.snapshot()).toEqual(['root']);
  });

  test('чужое поле history.state (адрес чата) сохраняется в корневой записи', () => {
    const { h } = setup({ chat: 7 });
    expect(h.state).toMatchObject({ chat: 7, i: 0 });
  });

  test('canPop: отказ возвращает записи, onBack не вызывается', async () => {
    let allow = false;
    const { h, nav, log, layer } = setup(null, { canPop: () => allow });
    layer('page', 'a');
    layer('page', 'edit');
    await h.userBack();
    expect(log).toEqual([]);
    expect(h.idx()).toBe(2);
    expect(nav.snapshot()).toEqual(['root', 'page:a', 'page:edit']);
    allow = true;
    await h.userBack();
    expect(log).toEqual(['back edit']);
  });

  test('topOpen и open пропускают закрытые', () => {
    const { nav, layer } = setup();
    layer('page', 'a');
    const c = layer('chat', 'c');
    layer('info', 'i');
    nav.close(c);
    expect(nav.topOpen()?.key).toBe('i');
    expect(nav.open('chat')).toEqual([]);
    expect(nav.open('page').map((e) => e.key)).toEqual(['a']);
  });

  test('closeAll закрывает все записи типа без onBack', async () => {
    const { h, nav, log, layer } = setup();
    layer('page', 'a');
    layer('chat', 'c1');
    layer('chat', 'c2');
    nav.closeAll('chat');
    await settle();
    expect(log).toEqual([]);
    expect(h.idx()).toBe(1);
    expect(nav.snapshot()).toEqual(['root', 'page:a']);
  });
});
