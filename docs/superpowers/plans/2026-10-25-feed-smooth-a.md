# PR A: драйвер прокрутки, ожидание анимаций, доезд к новому сообщению — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** лента не прыгает на новое сообщение, а доезжает; медиа и сдвиг окна не стартуют во время тяжёлых анимаций.

**Architecture:** один драйвер программной прокрутки (`scrollDrive.ts`, свой тайминг на rAF, цель-функция, отмена вводом) под окном тяжёлой анимации; `lazyObserve` и `shift` откладывают работу до `onHeavyAnimationEnd`; все три плавные прокрутки ленты (новое сообщение, кнопка «вниз», переход к сообщению) идут через драйвер и помечаются как программные флагом `driving`.

**Tech Stack:** Preact, bun test, relay-ui `schedule.js` (`beginHeavyAnimation`, `isHeavyAnimating`, `onHeavyAnimationEnd`, `forceMeasure`).

Спек: `docs/superpowers/specs/2026-10-25-feed-smoothness-design.md`, разделы 0, 1, 2.

## Global Constraints

- `docs/SMOOTH-UI.md`: чтение раскладки — `requestMeasure`, запись — `requestMutation`; `forceMeasure` только осознанно, с комментарием (кадр драйвера: одно чтение, одна запись).
- Только `transform`/`opacity` в CSS-анимациях; здесь CSS не меняется.
- Комментарии и строки — по-русски; стиль файла (однострочные стрелки, комментарии над блоками) сохраняется.
- `reducedMotion()` и `document.hidden` → без анимации, мгновенный переход.
- Никакого кода из telegram-tt/tweb.
- Коммиты заканчиваются `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `scrollDrive.ts` — драйвер прокрутки

**Files:**
- Create: `apps/web/src/ui/scrollDrive.ts`
- Test: `apps/web/src/ui/scrollDrive.test.ts`

**Interfaces:**
- Produces: `driveScroll(root, opts): Drive`, типы `DriveOpts`, `Drive`, константы `DRIVE_MS = 300`, `DRIVE_OWN_MS = 200`, функция `jumpNear(from, to, screen): number | null` (куда прыгнуть перед доездом, если далеко).

- [ ] **Step 1: тест**

```ts
// apps/web/src/ui/scrollDrive.test.ts
import { expect, test } from 'bun:test';
import { driveScroll, jumpNear } from './scrollDrive';

// ручные кадры: raf копит колбэки, tick() выполняет их с заданным временем
function clock() {
  const q: ((t: number) => void)[] = [];
  let t = 0;
  return {
    raf: (cb: (t: number) => void) => { q.push(cb); return q.length; },
    caf: () => { q.length = 0; },
    now: () => t,
    tick: (dt: number) => { t += dt; const cbs = q.splice(0); for (const cb of cbs) cb(t); },
  };
}

test('drive: eases from the current position to the target and lands exactly on it', () => {
  const c = clock(), root = { scrollTop: 0 };
  const ends: string[] = [];
  const d = driveScroll(root, { ms: 300, target: () => 600, onEnd: (r) => ends.push(r), ...c });
  expect(d.active).toBe(true);
  c.tick(0);                       // первый кадр — старт, позиция не меняется
  c.tick(150);
  expect(root.scrollTop).toBeGreaterThan(300);   // ease-out: к середине времени больше половины пути
  expect(root.scrollTop).toBeLessThan(600);
  c.tick(150);
  expect(root.scrollTop).toBe(600);
  expect(d.active).toBe(false);
  expect(ends).toEqual(['done']);
});

test('drive: the target is read every frame — it moves, we follow without restarting', () => {
  const c = clock(), root = { scrollTop: 0 };
  let bottom = 600;
  driveScroll(root, { ms: 300, target: () => bottom, ...c });
  c.tick(0); c.tick(150);
  const mid = root.scrollTop;
  bottom = 900;                    // пришло ещё сообщение
  c.tick(75);
  expect(root.scrollTop).toBeGreaterThan(mid);   // не откатывается и не прыгает в старт
  c.tick(75);
  expect(root.scrollTop).toBe(900);
});

test('drive: cancel stops where it is and reports cancel once', () => {
  const c = clock(), root = { scrollTop: 0 };
  const ends: string[] = [];
  const d = driveScroll(root, { ms: 300, target: () => 600, onEnd: (r) => ends.push(r), ...c });
  c.tick(0); c.tick(100);
  const at = root.scrollTop;
  d.cancel(); d.cancel();
  c.tick(200);
  expect(root.scrollTop).toBe(at);
  expect(ends).toEqual(['cancel']);
  expect(d.active).toBe(false);
});

test('drive: start jumps first (far target), then eases the last screen', () => {
  const c = clock(), root = { scrollTop: 0 };
  driveScroll(root, { ms: 300, target: () => 5000, start: 4100, ...c });
  c.tick(0);
  expect(root.scrollTop).toBe(4100);
  c.tick(300);
  expect(root.scrollTop).toBe(5000);
});

test('jumpNear: farther than two screens — one screen short of the target on the near side; else null', () => {
  expect(jumpNear(0, 5000, 900)).toBe(4100);
  expect(jumpNear(5000, 0, 900)).toBe(900);
  expect(jumpNear(0, 1500, 900)).toBeNull();
});
```

- [ ] **Step 2: запустить — падает**

Run: `cd apps/web && bun test src/ui/scrollDrive.test.ts`
Expected: FAIL — `Cannot find module './scrollDrive'`.

- [ ] **Step 3: реализация**

```ts
// apps/web/src/ui/scrollDrive.ts
import { forceMeasure } from '@relay/ui/schedule';

/**
 * Программная прокрутка ленты со своим таймингом (как animateScroll в Telegram), а не behavior:'smooth':
 * у браузерной «плавной» ни длительность не задаётся, ни цель на ходу не меняется. Цель — функция: читается
 * каждый кадр, так что пока едем к низу, пришедшее сообщение сдвигает цель, и мы доезжаем до нового низа без
 * перезапуска. Кадр — одно чтение и одна запись (осознанное исключение, forceMeasure): это сама анимация.
 */
export const DRIVE_MS = 300;       // чужое сообщение, кнопка «вниз», переход к сообщению
export const DRIVE_OWN_MS = 200;   // своё сообщение: отправил — сразу видишь

export type DriveOpts = {
  ms: number;
  target: () => number;             // куда едем (читается каждый кадр)
  start?: number;                   // прыжок перед доездом (далеко — сначала на экран от цели)
  onEnd?: (reason: 'done' | 'cancel') => void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
};
export type Drive = { cancel: () => void; readonly active: boolean };

const ease = (p: number) => 1 - (1 - p) ** 3;   // ease-out cubic — близко к cubic-bezier(.2, 0, 0, 1)

export function driveScroll(root: { scrollTop: number }, o: DriveOpts): Drive {
  const raf = o.raf ?? ((cb) => requestAnimationFrame(cb)), caf = o.caf ?? ((id) => cancelAnimationFrame(id));
  const now = o.now ?? (() => performance.now());
  let id = 0, t0 = -1, from = 0, active = true;
  const finish = (reason: 'done' | 'cancel') => { if (!active) return; active = false; caf(id); o.onEnd?.(reason); };
  const frame = () => {
    if (!active) return;
    forceMeasure(() => {
      if (t0 < 0) {   // первый кадр: прыжок, если просили, и точка старта
        t0 = now();
        if (o.start != null) root.scrollTop = o.start;
        from = root.scrollTop;
        id = raf(frame);
        return;
      }
      const p = Math.min(1, (now() - t0) / o.ms), to = o.target();
      root.scrollTop = p >= 1 ? to : from + (to - from) * ease(p);
      if (p >= 1) finish('done'); else id = raf(frame);
    });
  };
  id = raf(frame);
  return { cancel: () => finish('cancel'), get active() { return active; } };
}

/** Далеко (больше двух экранов) — сначала прыжок на экран от цели с ближней стороны, плавно — только последний экран. */
export function jumpNear(from: number, to: number, screen: number): number | null {
  if (Math.abs(to - from) <= screen * 2) return null;
  return to > from ? to - screen : to + screen;
}
```

Проверить, что `@relay/ui/schedule` импортируется из apps/web так же, как в Feed.tsx (посмотреть существующий import `beginHeavyAnimation` в `Feed.tsx` и повторить путь).

- [ ] **Step 4: тесты зелёные**

Run: `cd apps/web && bun test src/ui/scrollDrive.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: коммит**

```bash
git add apps/web/src/ui/scrollDrive.ts apps/web/src/ui/scrollDrive.test.ts
git commit -m "feat(feed): scrollDrive — programmatic scroll with own timing, live target and cancel"
```

---

### Task 2: `lazyObserve` ждёт конца тяжёлой анимации

**Files:**
- Modify: `packages/relay-ui/src/kit.js:984-1005` (`lazyObserve`)
- Test: `packages/relay-ui/src/lazyObserve.test.js`

**Interfaces:**
- Consumes: `isHeavyAnimating`, `onHeavyAnimationEnd`, `beginHeavyAnimation` из `./schedule.js` (уже импортированы в kit.js:7).
- Produces: прежняя сигнатура `lazyObserve(el, cb, root) → release`.

- [ ] **Step 1: тест**

Добавить в `lazyObserve.test.js` (после существующих; `beginHeavyAnimation` импортировать из `./schedule.js`):

```js
import { beginHeavyAnimation } from './schedule.js';

test('during a heavy animation the callback waits; it runs once the animation ends, with the last known state', () => {
  const root = {}, a = {}, b = {};
  let na = 0, nb = 0;
  lazyObserve(a, () => { na++; }, root);
  lazyObserve(b, () => { nb++; }, root);
  const io = made.at(-1);
  const end = beginHeavyAnimation(1000);
  io.fire(a);
  io.cb([{ target: b, isIntersecting: true }, { target: b, isIntersecting: false }]);   // b вошёл и вышел
  expect(na).toBe(0);
  expect(io.els.has(a)).toBe(true);        // наблюдение не снято: состояние может измениться до конца анимации
  end();
  expect(na).toBe(1);
  expect(nb).toBe(0);                      // последнее состояние b — вне зоны
  expect(io.els.has(a)).toBe(false);
  expect(io.els.has(b)).toBe(true);        // b ждёт следующего пересечения
});

test('released before the animation ends — the callback never runs', () => {
  const root = {}, a = {};
  let n = 0;
  const off = lazyObserve(a, () => { n++; }, root);
  const io = made.at(-1);
  const end = beginHeavyAnimation(1000);
  io.fire(a);
  off();
  end();
  expect(n).toBe(0);
});
```

- [ ] **Step 2: запустить — падает**

Run: `cd packages/relay-ui && bun test src/lazyObserve.test.js`
Expected: FAIL — `na` равно 1 до `end()`.

- [ ] **Step 3: реализация**

Заменить тело колбэка IO и `release` в `lazyObserve`:

```js
/* Пока идёт тяжёлая анимация (переход стека, доезд ленты), загрузку не начинаем: пересечения копятся
   (последнее состояние цели выигрывает, как заморозка наблюдателей в Telegram) и разбираются по её концу.
   Наблюдатель не отключаем — переподписка дороже, чем карта ожидающих. */
function lazyObserve(el, cb, root) {
  root = root || null;
  var ent = lazyIOs.get(root);
  if (!ent) {
    ent = { io: null, n: 0, pending: new Map(), waiting: false };
    ent.io = new IntersectionObserver(function (es) {
      if (isHeavyAnimating()) {
        es.forEach(function (e) { ent.pending.set(e.target, e.isIntersecting); });
        if (!ent.waiting) { ent.waiting = true; onHeavyAnimationEnd(function () { flushLazy(ent); }); }
        return;
      }
      es.forEach(function (e) { if (e.isIntersecting) fireLazy(e.target); });
    }, { root: root, rootMargin: '500px 0px' });
    lazyIOs.set(root, ent);
  }
  var done = false;
  function release() {
    if (done) return;
    done = true;
    lazyCbs.delete(el); ent.pending.delete(el); ent.io.unobserve(el);
    if (--ent.n === 0) { ent.io.disconnect(); if (lazyIOs.get(root) === ent) lazyIOs.delete(root); }
  }
  lazyCbs.set(el, { f: cb, release: release });
  ent.n++; ent.io.observe(el);
  return release;
}
function fireLazy(el) { var x = lazyCbs.get(el); if (x) { x.release(); x.f(); } }
function flushLazy(ent) {
  ent.waiting = false;
  var list = Array.from(ent.pending.entries());
  ent.pending.clear();
  list.forEach(function (p) { if (p[1]) fireLazy(p[0]); });
}
```

`lazyCbs` — WeakMap, когда есть; в среде без WeakMap (`lazyCbs === null`) код и раньше падал бы — не трогаем.

- [ ] **Step 4: тесты зелёные**

Run: `cd packages/relay-ui && bun test`
Expected: PASS, включая 2 старых теста lazyObserve.

- [ ] **Step 5: коммит**

```bash
git add packages/relay-ui/src/kit.js packages/relay-ui/src/lazyObserve.test.js
git commit -m "feat(ui): lazyObserve waits for the heavy animation to end before starting loads"
```

---

### Task 3: сдвиг окна ждёт конца тяжёлой анимации

**Files:**
- Modify: `apps/web/src/ui/windowShift.ts` (новая чистая функция `deferShift`)
- Modify: `apps/web/src/ui/Feed.tsx:526-535` (`shift`)
- Test: `apps/web/src/ui/windowShift.test.ts`

**Interfaces:**
- Produces: `deferShift(box: { dir: ShiftDir | null }, dir: ShiftDir, heavy: boolean, later: (fn: () => void) => void, run: (dir: ShiftDir) => void): void`.

- [ ] **Step 1: тест**

```ts
// добавить в windowShift.test.ts
import { deferShift, type ShiftDir } from './windowShift';

test('deferShift: during a heavy animation the last direction is kept and run once after it; idle — runs now', () => {
  const ran: ShiftDir[] = [];
  const later: (() => void)[] = [];
  const box = { dir: null as ShiftDir | null };
  deferShift(box, 'older', true, (fn) => later.push(fn), (d) => ran.push(d));
  deferShift(box, 'newer', true, (fn) => later.push(fn), (d) => ran.push(d));
  expect(ran).toEqual([]);
  expect(later).toHaveLength(1);           // одна подписка на конец анимации
  later[0]();
  expect(ran).toEqual(['newer']);          // последнее направление
  expect(box.dir).toBeNull();
  deferShift(box, 'older', false, (fn) => later.push(fn), (d) => ran.push(d));
  expect(ran).toEqual(['newer', 'older']);
});
```

- [ ] **Step 2: запустить — падает**

Run: `cd apps/web && bun test src/ui/windowShift.test.ts`
Expected: FAIL — `deferShift` не экспортирован.

- [ ] **Step 3: реализация**

В `windowShift.ts` (рядом с `shiftWanted`; `ShiftDir` там уже есть — проверить экспорт, при необходимости добавить `export`):

```ts
/** Сдвиг окна во время тяжёлой анимации (переход стека, доезд ленты) откладывается до её конца: перераскладка
 *  ленты съедала бы кадры анимации. Запоминается одно, последнее направление; после анимации сдвиг сам
 *  перепроверит, нужен ли он ещё. */
export function deferShift(box: { dir: ShiftDir | null }, dir: ShiftDir, heavy: boolean, later: (fn: () => void) => void, run: (dir: ShiftDir) => void): void {
  if (!heavy) { run(dir); return; }
  const had = box.dir;
  box.dir = dir;
  if (!had) later(() => { const d = box.dir; box.dir = null; if (d) run(d); });
}
```

В `Feed.tsx` заменить `shift`:

```ts
  const pendingShift = useRef<{ dir: 'older' | 'newer' | null }>({ dir: null });
  const shift = (dir: 'older' | 'newer') => deferShift(pendingShift.current, dir, isHeavyAnimating(), onHeavyAnimationEnd, (d) => {
    const root = el.current;
    if (!root || !placed.current || !shiftWanted(d, metaRef.current, scrollDir.current)) return;
    requestMeasure(() => {
      if (anchor.current) return; // предыдущий сдвиг ещё не применён
      // окно не двинулось (край в кадре уже пуст — лента не успела перерисоваться; прежний сдвиг в пути) — якорь
      // не держим: он ждал бы окна, которое не придёт, и окно встало бы в обе стороны
      anchor.current = requestShift(() => firstVisible(root), () => moveWindow(d, frameKey));
    });
  });
```

Импорт `deferShift` в строку импорта из `./windowShift`. `isHeavyAnimating`/`onHeavyAnimationEnd` в Feed.tsx уже импортированы (используются на 649, 721).

- [ ] **Step 4: тесты и типы**

Run: `cd apps/web && bun test src/ui/windowShift.test.ts && bunx -p typescript@5.9.3 tsc -p . --noEmit 2>&1 | grep -c "error TS"`
Expected: PASS; число ошибок tsc равно числу на master (сравнить `git stash`-ом не нужно — число на master известно из предыдущих прогонов: сверить с `cd ~/Documents/relay/apps/web && bunx -p typescript@5.9.3 tsc -p . --noEmit | grep -c "error TS"`).

- [ ] **Step 5: коммит**

```bash
git add apps/web/src/ui/windowShift.ts apps/web/src/ui/windowShift.test.ts apps/web/src/ui/Feed.tsx
git commit -m "feat(feed): window shift waits for the heavy animation to end"
```

---

### Task 4: лента едет через драйвер — новое сообщение, «вниз», переход к сообщению

**Files:**
- Modify: `apps/web/src/ui/Feed.tsx` (эффект раскладки 538-594, `onScroll` 826-848, `toLatest` 850-855, эффект focus 857-889, новые слушатели отмены)
- Modify: `docs/SMOOTH-UI.md` §4 — одна строка про драйвер

**Interfaces:**
- Consumes: `driveScroll`, `jumpNear`, `DRIVE_MS`, `DRIVE_OWN_MS` из `./scrollDrive`; `beginHeavyAnimation`, `reducedMotion` (есть в Feed.tsx: `reducedMotion()` на 621).

- [ ] **Step 1: инфраструктура драйвера в Feed**

После `const lastTop = useRef(0);` (525):

```ts
  // программная плавная прокрутка (scrollDrive.ts): одна на ленту, пока едет — события scroll наши, не пользователя
  const driving = useRef<Drive | null>(null);
  const driveSince = useRef(0);
  /** Поехать к цели: далеко — сначала прыжок на экран от неё. Без анимаций или в скрытой вкладке — сразу. */
  const drive = (root: HTMLElement, target: () => number, ms: number) => {
    driving.current?.cancel();
    const to = target(), from = root.scrollTop, screen = root.clientHeight;
    if (reducedMotion() || document.hidden) { if (Math.abs(to - from) > 0.5) { programmatic.current++; root.scrollTop = to; } return; }
    const start = jumpNear(from, to, screen);
    // поток сообщений: едем дольше 600 мс подряд — дальше без анимации, пока не будет паузы
    const now = performance.now();
    if (driveSince.current && now - driveSince.current > 600) { if (Math.abs(to - from) > 0.5) { programmatic.current++; root.scrollTop = to; } return; }
    if (!driveSince.current) driveSince.current = now;
    const end = beginHeavyAnimation(ms);
    driving.current = driveScroll(root, { ms, target, start: start ?? undefined, onEnd: () => {
      end();
      driving.current = null;
      setTimeout(() => { if (!driving.current) driveSince.current = 0; }, 300);
      // где остановились — пересчитать «прижата к низу» и кнопку «вниз» (события scroll драйвера пропускались)
      requestMeasure(() => {
        const fromBottom = root.scrollHeight - root.scrollTop - root.clientHeight, live = metaRef.current?.live ?? true;
        lastTop.current = root.scrollTop;
        stick.current = fromBottom < BOTTOM && live;
        setAway(fromBottom > root.clientHeight || !live);
      });
    } });
  };
  // первый ввод пользователя обрывает поездку: дальше лента его
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const stop = () => driving.current?.cancel();
    const keys = (e: KeyboardEvent) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) stop(); };
    root.addEventListener('wheel', stop, { passive: true });
    root.addEventListener('touchstart', stop, { passive: true });
    root.addEventListener('pointerdown', stop);
    root.addEventListener('keydown', keys);
    return () => { root.removeEventListener('wheel', stop); root.removeEventListener('touchstart', stop); root.removeEventListener('pointerdown', stop); root.removeEventListener('keydown', keys); };
  }, [chatId]);
  useEffect(() => () => driving.current?.cancel(), []);   // размонтирование — драйвер не пишет в мёртвый узел
```

Вызов `drive` — только из `requestMutation`/layout-эффекта (он пишет `scrollTop` при мгновенном пути).

Импорт: `import { driveScroll, jumpNear, DRIVE_MS, DRIVE_OWN_MS, type Drive } from './scrollDrive';`

- [ ] **Step 2: `onScroll` пропускает кадры драйвера**

В `onScroll` первой строкой внутри `requestMeasure` (перед чтением `top`):

```ts
    requestMeasure(() => {
      if (driving.current) { lastTop.current = root.scrollTop; return; }   // едем сами: направление, низ и сдвиги не трогаем
      const top = root.scrollTop, prev = lastTop.current;
```

Остальное без изменений (даты, viewAnchor, позиция — пусть обновляются и во время поездки).

- [ ] **Step 3: новое сообщение у низа — доезд**

В основной ветке эффекта раскладки (579-593) заменить `forceMeasure`-блок:

```ts
    // пришло новое в живую ленту, прижатую к низу (свежие — из arrivals этого рендера) — доезжаем, как Telegram,
    // а не прыгаем: контент остаётся на месте, лента едет к новому низу. Остальное (якорь, «вниз», перераскладка
    // при stick) — как раньше, одним кадром
    const fresh = [...appearAt.current.keys()].filter((k) => !before?.has(k));
    const arrived = !a && !down && stick.current && fresh.length > 0 && (metaRef.current?.live ?? true);
    if (arrived) {
      const own = fresh.every((k) => messages.find((m) => m.key === k)?.senderId === meId);
      requestMutation(() => drive(root, () => root.scrollHeight - root.clientHeight, own ? DRIVE_OWN_MS : DRIVE_MS));
      return;
    }
    forceMeasure(() => { …как было… });
```

Примечание: `before` — `shownKeys.current` до обновления (переменная уже объявлена на 541 как `before`). `fresh` берётся из `appearAt` (ключи, добавленные `arrivals` в этом рендере — у них `now - t` ≈ 0; достаточно фильтра «не было в прошлом окне»).

Случай `document.hidden`/reduced motion внутри `drive` ставит низ сразу — поведение как раньше.

- [ ] **Step 4: `toLatest` через драйвер**

```ts
  const toLatest = () => {
    stick.current = true;
    const root = el.current!;
    if (metaRef.current && !metaRef.current.live) { toBottom.current = true; moveWindow('latest', frameKey); return; }
    requestMutation(() => drive(root, () => root.scrollHeight - root.clientHeight, DRIVE_MS));
  };
```

- [ ] **Step 5: переход к сообщению через драйвер**

В эффекте focus ветку `else` заменить:

```ts
    } else {
      requestMutation(() => {
        // как в Telegram: далеко — сначала прыжок почти к цели (jumpNear внутри drive), плавно — только последний экран
        // (иначе прокрутка пролетает десятки пузырей и кружков, каждый из которых просыпается — кадры проседают).
        // Пока едем — тяжёлая анимация: кружки не запускают видео, отложенная работа ждёт
        drive(root, () => Math.max(0, topIn(root, row) - (root.clientHeight - row.offsetHeight) / 2), DRIVE_MS);
      });
    }
```

`topIn` читает раскладку — внутри драйвера это кадр `forceMeasure`, допустимо (цель-функция).

- [ ] **Step 6: SMOOTH-UI.md**

В §4 «Лента и списки» добавить пункт:

```
- Плавная прокрутка ленты (новое сообщение у низа, «вниз», переход к сообщению) — только через `scrollDrive.ts`:
  свой тайминг, цель читается каждый кадр, поездка под `beginHeavyAnimation`, первый ввод пользователя её обрывает;
  `behavior: 'smooth'` в ленте не используется. Без анимаций и в скрытой вкладке — мгновенно.
```

- [ ] **Step 7: типы и тесты web**

Run: `cd apps/web && bun test && bunx -p typescript@5.9.3 tsc -p . --noEmit 2>&1 | grep -c "error TS"`
Expected: все тесты PASS; ошибок tsc не больше, чем на master.

- [ ] **Step 8: коммит**

```bash
git add apps/web/src/ui/Feed.tsx docs/SMOOTH-UI.md
git commit -m "feat(feed): new messages, «down» and jump-to-message scroll through scrollDrive under a heavy-animation window"
```

---

### Task 5: проверка в браузере и замер

**Files:** без изменений кода (если найдены дефекты — правки в Feed.tsx/scrollDrive.ts с отдельными коммитами).

- [ ] **Step 1: собрать стек ветки** — отдельный compose-проект (как `relay-viewer-open`: override с `!override` портами, prod-сборка web), применить миграции, залогиниться dev-логином.
- [ ] **Step 2: сценарии** (Chrome, продакшен-сборка, сэмплер кадров из `docs/SMOOTH-UI.md` §6, 5 прогонов каждый):
  1. Открыть канал с альбомами (`#chat=23626`): первая сетевая загрузка картинки — после конца перехода стека; кадров > 17 мс во время перехода — 0.
  2. Личный чат, прижат к низу, прислать сообщение вторым пользователем: верх видимой области смещается монотонно, нет кадра со скачком ≥ высоты пузыря; своё сообщение — доезд 200 мс.
  3. Во время доезда крутануть колесо вверх — поездка прекращается, `stick` снят, кнопка «вниз» появляется по расстоянию.
  4. Кнопка «вниз» с расстояния > 2 экранов — прыжок + последний экран плавно; с 1 экрана — плавно целиком.
  5. Переход по цитате далеко вверх — как раньше, подсветка на месте; сдвиг окна не стартует до конца поездки.
  6. `prefers-reduced-motion` (Chrome DevTools rendering) — всё мгновенно; скрытая вкладка — без анимации.
- [ ] **Step 3: результаты** — таблица до/после в описании PR; при регрессии — чинить до зелёного.

---

### Task 6: PR

- [ ] `git push -u origin feat/feed-smooth-a`, `gh pr create --base master` с описанием (симптом → причина → решение по пунктам 0/1/2, таблица замеров, тесты), в конце `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Не вливать.

## Self-review

- Спек 0.1: тайминг свой ✔, цель-функция ✔, флаг `driving` ✔, окно анимации ✔, отмена вводом ✔, reduced/hidden ✔, кривая и длительности ✔, три места ✔.
- Спек 1: lazyObserve ✔ (Task 2), shift ✔ (Task 3), не трогаем дорисовку/прочтение ✔.
- Спек 2: нет `scrollTop = h` при новых сообщениях ✔, 200/300 ✔, >экрана — прыжок ✔ (jumpNear), перенацеливание ✔, отмена ✔, появление пузыря параллельно ✔, перераскладка при stick без анимации ✔ (ветка `arrived` только при свежих ключах), поток — защита 600 мс ✔.
- Типы: `Drive`, `DriveOpts`, `deferShift` согласованы между задачами ✔.
