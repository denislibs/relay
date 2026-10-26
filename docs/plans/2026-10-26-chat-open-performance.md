# Быстрое открытие и переключение чатов — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Замеры — по личному навыку `relay-perf` (~/.claude/skills/relay-perf).

**Цель:** чат из списка открывается и переключается без длинных задач в кадре смены и без рывков в переходе. Загрузка до списка чатов становится короче.

**Архитектура:** пять независимых исправлений, по одному PR на каждое, в порядке от дешёвого к рискованному.
1. Мелочи на каждом открытии: подписи дат, регулярка эмодзи, **иконки через спрайт**.
2. Дешевле раскладка ленты, которую оплачивает восстановление якоря.
3. Тяжёлое (холсты, плееры, анимации входа) — после смены чата, а не в её кадре.
4. Нижняя колонка чата постоянна. По чату заново строится только лента; новая собирается скрыто и подменяется разом. Шапка и композер меняют чат на месте.
5. Загрузка: проверка гипотезы со шрифтом эмодзи, разделение бандла, плашка уведомлений.

**Стек:** Preact, Bun.build, свой кит `packages/relay-ui` (`schedule.js`: `requestMeasure`, `requestMutation`, `forceMeasure`, `beginHeavyAnimation`, `deferDuringAnimation`), движок в SharedWorker.

## Global Constraints

- Плавный UI прежде всего: никаких вспышек пустоты, прыжков ленты и якоря (`docs/SMOOTH-UI.md`, память relay-smooth-ui).
- Дисциплина фаз: чтения раскладки — в `requestMeasure`, записи — в `requestMutation`; `forceMeasure` — только осознанные исключения. Строгий DOM в dev — 0 нарушений.
- Правила стека (`docs/navigation-rules.md`) не меняются: левая колонка заменяет (`openChat`), внутри чата и правой панели — поверх (`openInner`).
- Никакого кода telegram-tt и tweb (GPL): только поведение, своя реализация.
- Проверка только в Chrome (chrome-devtools MCP, изолированный контекст, 127.0.0.1, вход «Анна Смирнова»), не во встроенном браузере Claude.
- В каждом PR — цифры «до и после» одним и тем же сценарием (`~/.claude/skills/relay-perf/scripts/bench-open-switch.js`) на prod-сборке при CPU ×4, медиана из 3 прогонов.

## Что взято из анализа telegram-tt и tweb

- **tt.** Шапка вне анимации, живёт постоянно. Анимация слайда только при смене глубины стека: при открытии из списка ключ слайда не меняется. Заново монтируется только список сообщений (ключ `чат-тред-тип`), композер получает новый `chatId` как свойство.
- **tweb.** Один объект чата на нижнюю позицию, `setPeer` его перенастраивает. Новая лента собирается вне DOM и подменяется одним синхронным `replaceChildren`. Шапка и поле ввода меняются в две фазы (подготовить, затем применить в том же блоке, что и подмена ленты), фон — там же. Ленивая загрузка медиа и анимации стикеров заморожены на время смены.
- **Relay сейчас.** `openChat` уже держит прежний чат, пока грузятся данные, и меняет шапку и ленту одним кадром (`instant`). Но у нового кадра новый `key`, поэтому `ChatStack` монтирует колонку целиком (~1400 узлов) прямо в кадре смены.

## Базовая линия (аудит `docs/perf-audit-2026-10-26.md`, master `a1bef8f`, prod, CPU ×4)

| Сценарий | Сейчас |
|---|---|
| Открытие чата, первое в сессии | 313–342 мс, задача 173–278 мс |
| Открытие чата, повторные | медиана 129 мс, задачи 52–88 мс |
| 10 быстрых переключений | 8 рывков, кадр до 101 мс, 7 задач, 538 мс всего |
| Загрузка: список на экране | 650 мс, 4–5 задач по 57–147 мс; телефон ×6 ≈ 1,0 с |
| Разбор (dev, ×4), 8 переключений | `removeChild` 469 мс*, `get scrollHeight` 346 мс, `set innerHTML` 207–272 мс (иконки; на prod — ~5 мс, остальное обёртки strict-dom, см. задачу 3), `setTimeout`/`clearTimeout` 140 мс, `dayLabel` 37 мс |

\* сам DOM дешёвый: удаление клона ленты занимает 0,6–1,9 мс. Это цена снятия колонки целиком, её убирает задача 8.

## Структура файлов

| Файл | Что меняется | Задача |
|---|---|---|
| `apps/web/src/ui/format.ts` | кэш форматтеров и подписей дня | 1 |
| `packages/protocol/src/emoji.ts` | быстрый отказ до регулярки, прогрев | 2 |
| `packages/relay-ui/src/kit.js` (`Icon`, `trustedIcon`) | иконки VK и пака — символы спрайта + `<use>` | 3 |
| `packages/relay-ui/src/iconSprite.js` (новый) | спрайт: символ добавляется при первом использовании | 3 |
| `apps/web/public/app.css`, `packages/relay-ui/relay.css` | `contain` у строк ленты | 4 |
| `apps/web/src/ui/Feed.tsx` (775–870) | проверка якоря после `contain` | 4 |
| `apps/web/src/data.ts` (`openChat`, коммит нижнего кадра) | окно «смена чата» (`beginHeavyAnimation`) | 5 |
| `packages/relay-ui/src/StickerView.js`, превью ссылок, волна голосовых, спойлеры | создание холстов — `deferDuringAnimation` | 5 |
| `apps/web/src/ui/ChatStack.tsx` | постоянный ключ нижней колонки | 6–8 |
| `apps/web/src/ui/Chat.tsx` | сброс состояния чата при смене `frameKey`; `Feed key={frameKey}` | 6–7 |
| `apps/web/src/ui/Chat.tsx` + `Feed.tsx` | следующая лента собирается скрыто в той же колонке | 8 |
| `apps/web/build.ts` | `splitting: true`, ленивые разделы | 10 |
| `apps/web/src/ui/settings/*`, `ui/stickers/*`, `ui/group/*`, `ui/auth/*` | точки `import()` | 10 |

---

## Исправление 1. Мелочи на каждом открытии

### Task 1: подписи дат без нового форматтера на сообщение

**Files:** Modify `apps/web/src/ui/format.ts:42-49`; Test `apps/web/src/ui/format.test.ts` (создать, если нет).

**Interfaces:** `dayLabel(iso: string): string` — подпись не меняется, меняется только реализация.

- [ ] **Step 1: тест**
```ts
import { expect, test } from 'bun:test';
import { dayLabel } from './format';
test('dayLabel: сегодня, вчера, дата этого года, дата прошлого года', () => {
  const now = new Date();
  const d = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString();
  expect(dayLabel(d(0))).toBe('Сегодня');
  expect(dayLabel(d(1))).toBe('Вчера');
  expect(dayLabel(new Date(now.getFullYear(), 0, 5, 12).toISOString())).toMatch(/^5 января$|^Сегодня$|^Вчера$/);
  expect(dayLabel(new Date(now.getFullYear() - 1, 2, 8, 12).toISOString())).toBe(`8 марта ${now.getFullYear() - 1} г.`);
});
test('dayLabel: тот же день — та же строка из кэша', () => {
  const iso = new Date(2020, 4, 9, 10).toISOString();
  expect(dayLabel(iso)).toBe(dayLabel(new Date(2020, 4, 9, 23).toISOString()));
});
```
- [ ] **Step 2:** `cd apps/web && bun test src/ui/format.test.ts` — убедиться, что ожидания совпадают с текущим поведением (тест должен пройти и до правки: это тест на неизменность).
- [ ] **Step 3: реализация**
```ts
const DAY_SAME_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const DAY_OTHER_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dayCache = new Map<string, string>();   // ключ: день + «сегодня» (подписи «Сегодня/Вчера» зависят от текущей даты)

export function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const key = day(d) + ':' + day(now);
  const hit = dayCache.get(key);
  if (hit) return hit;
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const label = diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера'
    : (d.getFullYear() === now.getFullYear() ? DAY_SAME_YEAR : DAY_OTHER_YEAR).format(d);
  if (dayCache.size > 500) dayCache.clear();
  dayCache.set(key, label);
  return label;
}
```
- [ ] **Step 4:** тест проходит; `bunx tsc --noEmit -p apps/web` без новых ошибок.
- [ ] **Step 5:** коммит `perf(web): dayLabel caches Intl formatters and labels per day`.

### Task 2: регулярка эмодзи — дешёвый отказ и прогрев

**Files:** Modify `packages/protocol/src/emoji.ts:18-40`; Test `packages/protocol/src/emoji.test.ts` (дополнить или создать).

- [ ] **Step 1: тест на неизменность** `emojiOnly`: `'👍'`, `'👍👍'`, `'❤️'`, `'🇰🇿'`, `'👨‍👩‍👧'` → не null; `'ok 👍'`, `'123'`, `'—'`, `'…'`, `'¯\\_(ツ)_/¯'` → null.
- [ ] **Step 2: быстрый отказ.** Перед разбором на графемы: если в строке нет ни одного символа из диапазонов эмодзи, сразу `null`. Признак — `/[©®‼-㊙\u{1F000}-\u{1FAFF}\u{E0020}-\u{E007F}‍️]/u` (широкая проверка). Точность остаётся за `RGI`.
- [ ] **Step 3: прогрев.** Экспорт `warmEmoji()`: один вызов `RGI.test('😀')`. Из `apps/web/src/main.tsx` вызывать в `requestIdleCallback` (с фолбэком на `setTimeout` 2000) после первого экрана.
- [ ] **Step 4:** тесты; коммит `perf(protocol): emojiOnly rejects non-emoji text before the RGI regex; warm it when idle`.

### Task 3: иконки через спрайт вместо разбора SVG на каждую иконку — ОТМЕНЕНА

> **Отменена по замеру (PR #97).** На prod-сборке при ×4 70 иконок через `innerHTML` стоят 3,3–5,3 мс, клонированием готового шаблона — 2–3 мс; это около 1,5 мс на открытие чата. Большие 207–272 мс `set innerHTML` в dev-трейсе дали обёртки strict-dom вокруг сеттера, а не браузер. Переход на `<use>` к тому же сломал бы ~15 hover-анимаций в `relay.css`, которые стилизуют пути внутри иконок. Описание ниже оставлено для истории.


**Почему.** `Icon` (`kit.js:236-268`) у иконок VK и пака вставляет внутренности `<svg>` через `dangerouslySetInnerHTML`. `TrustedHTML` кэшируется (`trustedIcon`), но браузер на каждом монтировании заново разбирает разметку. В ленте около 70 иконок (статусы, галочки, кнопки), при 8 переключениях это 207–272 мс (dev, ×4). tt и tweb рисуют иконки шрифтом. Наш аналог — символы спрайта: каждая иконка разбирается один раз, а на экране стоит короткий `<use>`.

**Files:** Create `packages/relay-ui/src/iconSprite.js`; Modify `packages/relay-ui/src/kit.js` (`Icon`, `trustedIcon`); Test `packages/relay-ui/src/iconSprite.test.js`.

**Interfaces:**
- Produces: `iconRef(key: string, viewBox: string, inner: TrustedHTML|string): string` — гарантирует символ `#rl-i-<key>` в спрайте и возвращает `'#rl-i-' + key`.

- [ ] **Step 1: тест** (happy-dom или jsdom, как в остальных тестах кита):
```js
import { expect, test } from 'bun:test';
import { iconRef, spriteRoot } from './iconSprite.js';
import { flushFrames } from './schedule.js';
test('символ создаётся один раз и переиспользуется', () => {
  const a = iconRef('vk:check', '0 0 24 24', '<path d="M1 1"/>');
  const b = iconRef('vk:check', '0 0 24 24', '<path d="M1 1"/>');
  flushFrames(2);
  expect(a).toBe('#rl-i-vk-check');
  expect(b).toBe(a);
  expect(spriteRoot().querySelectorAll('symbol').length).toBe(1);
  expect(spriteRoot().querySelector('symbol').getAttribute('viewBox')).toBe('0 0 24 24');
});
```
- [ ] **Step 2: спрайт.**
```js
import { requestMutation } from './schedule.js';
// Спрайт иконок: символ на имя, добавляется при первом использовании (одна разборка разметки на иконку на страницу).
// Вставка символа — запись в DOM: не из рендера, а в фазе записи кадра (рендер Preact идёт там же, раньше отрисовки).
var root = null, have = new Set();
export function spriteRoot() {
  if (!root) {
    root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    document.body.prepend(root);
  }
  return root;
}
export function iconRef(key, viewBox, inner) {
  var id = 'rl-i-' + key.replace(/[^a-z0-9_-]/gi, '-');
  if (!have.has(id)) {
    have.add(id);
    requestMutation(function () {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
      s.id = id; s.setAttribute('viewBox', viewBox);
      s.innerHTML = inner;   // TrustedHTML из trustedIcon (политика relay-icons)
      spriteRoot().appendChild(s);
    });
  }
  return '#' + id;
}
```
  `Icon` рендерит `<use>` сразу, а символ вставляется в той же фазе записи, до отрисовки. `<use>` с ещё не существующей целью ничего не рисует и не ломается, а к отрисовке цель уже есть. Проверить в трейсе, что первый кадр с новой иконкой не пустой. Если пустой, вставлять символ синхронно в `forceMeasure`-исключении с комментарием.

  В тесте Step 1 после `iconRef` вызвать `flushFrames(2)` из `schedule.js` и только потом проверять `spriteRoot()`.
- [ ] **Step 3: `Icon`.** Ветки VK и пака:
```js
if (vk) return h('svg', Object.assign(base, { viewBox: vk[0], fill: 'currentColor' }),
  h('use', { href: iconRef('vk:' + name, vk[0], trustedIcon('vk:' + name, vk[1])) }));
...
if (pack) return h('svg', Object.assign(base, { fill: 'none', stroke: 'currentColor', 'stroke-width': props.strokeWidth || 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  h('use', { href: iconRef(name, '0 0 24 24', trustedIcon(name, pack)) }));
```
  `stroke`, `fill` и `stroke-width` наследуются в теневое дерево `<use>` от внешнего `<svg>`, поэтому толщина и цвет остаются прежними. Проверить глазами иконки с особой толщиной (`strokeWidth`) и залитые.
- [ ] **Step 4: проверка в Chrome (dev):** список чатов, лента, композер, меню сообщения, настройки — иконки на месте в светлой и тёмной теме; строгий DOM — 0; `set innerHTML` в трейсе переключений — почти 0.
- [ ] **Step 5:** коммит `perf(ui): icons render as <use> of sprite symbols instead of parsing SVG per icon`.

### Task 4: замер исправления 1
- [ ] Prod-сборка ветки на 8083, `bench-open-switch.js` при ×4, три прогона. В PR: таблица против базовой линии; трейс dev с `trace-top.cjs` (доля `set innerHTML`, `dayLabel`, `isEmoji`).
- [ ] PR «perf: cheaper chat open — day labels, emoji check, icon sprite».

---

## Исправление 2. Дешевле раскладка, которую оплачивает якорь

`Feed.tsx:775-800` и `855-870` читают `scrollHeight` в `forceMeasure` сразу после вставки ленты. Убирать чтение нельзя: браузер всё равно разложил бы ленту перед отрисовкой, а лента прыгнула бы. Лечим стоимость раскладки.

### Task 5: `contain` у строк ленты, затем эксперимент с `content-visibility`

**Files:** Modify `apps/web/public/app.css:48` (`.app-msg`), при необходимости `packages/relay-ui/relay.css`.

- [ ] **Step 1: проверить, что внутри строки нет `position: fixed`, которому строка не должна становиться контейнером.** `contain: layout` делает строку контейнером для `fixed` и `absolute`. Меню и пикеры реакций у нас порталы (`createPortal`), это подтвердить поиском `position: fixed` внутри `.app-msg` и `.rl-bubble`.
- [ ] **Step 2: вариант A.**
```css
.app-msg { position: relative; contain: layout style; }
```
  Сценарии проверки:
  - якорь по трём путям (сохранённая позиция, разделитель «Непрочитанные», низ) — `scrollTop` до и после совпадает в пределах 1 px;
  - липкие даты (`.rl-date` sticky — проверить, что они не внутри `.app-msg`);
  - полёт пузыря при отправке (`sendFlight.ts`);
  - выделение сообщений;
  - реакции, превью ссылок.
- [ ] **Step 3: замер** (dev, ×4, трейс открытия): собственное время `get scrollHeight` и общий Layout.
- [ ] **Step 4: вариант B, только если A дал мало.**
```css
.app-msg { content-visibility: auto; contain-intrinsic-size: auto 56px; }
```
  `auto` запоминает реальную высоту после первой отрисовки. Риск в оценке высоты строк, которых ещё не видели: прыгает якорь при прокрутке вверх. Принимаем, только если по тем же трём путям якорь точный, а при прокрутке истории (200 шагов вверх по чату 500) нет видимых скачков. Проверить на скриншотах кадров.
- [ ] **Step 5:** коммит и PR с цифрами; в PR явно указать, какой вариант оставлен и почему.

---

## Исправление 3. Тяжёлое — после смены чата

Нижняя смена сейчас `instant` и `beginHeavyAnimation` не вызывает, поэтому холсты стикеров, волны голосовых, спойлеры и анимация входа превью ссылок создаются прямо в кадре смены. Отсюда `drawImage` 114 мс за 8 переключений. Ленивые картинки уже ждут конца тяжёлых анимаций (`kit.js:1069`), остальное — нет. Аналог в tweb — `lazyLoadQueue.lock()` и `animationIntersector.lockGroup`.

### Task 6: окно «смена чата» и отложенные холсты

**Files:** Modify `apps/web/src/data.ts` (`openChat`, коммит `ready` нижнего кадра); `packages/relay-ui/src/StickerView.js`; компонент волны голосовых (`rl-vb-wave`), спойлеров (`rl-spoiler-canvas`), анимация `rl-webpage-in`.

- [ ] **Step 1:** в коммите нижнего кадра (`setGlobal({ chatStack: [ready] … })`) вызвать `beginHeavyAnimation(SETTLE_MS)` с `SETTLE_MS = 250`. Ленивые картинки и всё, что уже смотрит на `isHeavyAnimating`, сами отложатся.
- [ ] **Step 2:** создание холста и плеера в `StickerView` — через `deferDuringAnimation`. До этого — контур (`outline`) или превью нужного размера, без смены размера после (плавный UI).
- [ ] **Step 3:** то же для волны голосовых и холста спойлера. Анимацию входа превью ссылок не запускать у пузырей, которые смонтировались в окне смены: они появляются сразу.
- [ ] **Step 4: проверка.**
  - «Кадры» на dev: 10 переключений — в кадрах смены нет меток стикеров, а длинные задачи стали короче.
  - Глазами: стикеры и голосовые проявляются через ~250 мс без прыжка размера.
  - Строгий DOM — 0.
- [ ] **Step 5:** коммит и PR с цифрами `bench-open-switch` и разбивкой `drawImage`.

---

## Исправление 4. Нижняя колонка постоянна, лента подменяется разом

Самое большое и рискованное исправление, поэтому оно разбито на три PR. Каждый можно влить отдельно, и каждый даёт выигрыш сам по себе.

### Task 7 (PR 4a): постоянный ключ нижней колонки, сброс состояния чата

**Files:** Modify `apps/web/src/ui/ChatStack.tsx:23-24`; `apps/web/src/ui/Chat.tsx`.

- [ ] **Step 1: `ChatStack`.** У колонки на позиции 0, которую заменяет `openChat`, ключ постоянный:
```tsx
{cols.map(({ f, place, instant, pending }, i) => <ChatColumn key={i === 0 && place !== 'above' ? 'bottom' : f.key} … />)}
```
  Ключи уходящих колонок (`chatLeaving`) и верхних кадров не меняются: поведение «Назад» и разворота сохраняется. `frameKey` по-прежнему уникален: сессии ленты (`closeSession`), `frameByKey` и всё остальное в данных — по нему.
- [ ] **Step 2: `Feed key={frameKey}`** в `Chat.tsx:618`. Лента монтируется заново на каждый чат (как `MessageList` в tt), а внутренние ссылки (`placed`, `anchor`, `shownKeys`) обнуляются сами.
- [ ] **Step 3: сброс состояния чата при смене `frameKey`.** Одна функция `resetForChat()`, вызываемая из `useLayoutEffect(() => …, [frameKey])` (пропуская первый вызов). В ней сбрасывается всё, что принадлежит чату:
  - `menu`, `rpanel`, `fwdMenu`, `readByOf`, `replyKey`, `editing`;
  - `finding`, `findQ`, `listOpen`, `findClosing`;
  - `musicOpen`, `pollOpen`, `geoOpen`, `contactOpen`;
  - `pendingDur`, `dragging`; `art` и `lp` (уже по `[chatId]`); выделение (`endSelect`, уже по `[chatId]`);
  - `stick.current = true`.
  Таблица в PR: каждое `useState`/`useRef` в `Chat.tsx` — сбрасывается или общий для колонки, с обоснованием.
- [ ] **Step 4: композер.** Остаётся тем же экземпляром:
  - черновик прежнего чата сохраняется (`flushDraft` уже на `pagehide`, вызвать и при смене);
  - `api.current.setValue(черновик нового чата)`;
  - вложения в загрузке остаются за своим чатом: очередь отправки по `chatId`, в композере нового чата их нет;
  - фокус не теряется, если он был в поле ввода.
- [ ] **Step 5: тесты.** Где есть тестовая обвязка (`apps/web/src/*.test.ts`): чистая функция «состояние чата при смене» и проверка черновиков. В браузере — чек-лист. Открыть в чате A: ответ, правку, поиск по чату, меню сообщения, выделение, записанный, но не отправленный черновик. Переключиться в B: ничего из этого в B нет. Вернуться в A: черновик на месте, остальное закрыто (как в Telegram).
- [ ] **Step 6: замер** `bench-open-switch` (×4) против базовой линии и против исправлений 1–3. PR 4a.

### Task 8 (PR 4b): следующая лента собирается скрыто, подмена разом

По образцу tweb (`chatInner` вне DOM, затем `replaceChildren`) и нашего же `openInner` (колонка готовится скрытой, переключение — смена классов).

**Files:** `apps/web/src/ui/Chat.tsx`, `apps/web/src/ui/Feed.tsx`, `apps/web/src/data.ts` (`openChat`).

- [ ] **Step 1:** пока данные нового чата грузятся (`startFeed`), а на экране старый, `Chat` рендерит вторую ленту нового кадра в скрытом слое той же колонки (`visibility: hidden; position: absolute; inset: 0`). Это сразу после `patchFrame(...)` с сообщениями, ещё до `ready`.
- [ ] **Step 2:** якорь новой ленты ставится в скрытом слое: `forceMeasure` работает и на скрытом слое, потому что `visibility` не отменяет раскладку.
- [ ] **Step 3: коммит** (`ready`) — одна запись в фазе мутаций: скрытый слой становится видимым, прежняя лента прячется. Шапка и композер получают новый чат в том же рендере (две фазы tweb: всё готово, применяется одной записью).
- [ ] **Step 4:** прежняя лента размонтируется в `requestIdleCallback`, не в кадре смены.
- [ ] **Step 5: проверка.** В кадре смены (трейс, ×4) нет длинной задачи от рендера ленты. Ни одного кадра со смесью «шапка нового — лента старого» (кадры через `requestAnimationFrame`-сэмплер, как в аудите). Строгий DOM — 0. PR 4b.

### Task 9 (PR 4c, по результатам замера): шапка без перемонтирования панелей
- [ ] Если после 4a/4b в трейсе смены заметны шапка или закреплённые (`app-pins`, плеер): разобрать, какие из них монтируются заново на смену чата, и перевести на смену свойств. Решение — по цифрам, иначе пропустить.

---

## Исправление 5. Загрузка

### Task 10: гипотеза «шрифт эмодзи в первой раскладке»
- [ ] **Step 1: эксперимент** на prod-сборке, ×4, три загрузки, трейс. В `initScript` до загрузки добавить стиль, скрывающий эмодзи на первом экране: плашку уведомлений (`🔔`) и превью строк — через `font-family` без цветного шрифта или временную замену текста. Сравнить первую раскладку (сейчас 436 мс на 76 объектов).
- [ ] **Step 2:** если подтвердится, вынести первое использование цветного шрифта за первый кадр (иконка вместо `🔔` в плашке) и прогреть шрифт в простое. Если нет — записать в аудит, что гипотеза отвергнута, и разобрать раскладку по `Layout` в трейсе (`beginData.stackTrace`).

### Task 11: разделение бандла
`main` весит 1,6 МБ (400 КБ в brotli). В нём наборы и пикеры стикеров (184 КБ), настройки (113 КБ), группы (48 КБ), вход с `libphonenumber-js` (~160 КБ, нужен только без сеанса), все иконки VK (201 КБ).

**Files:** `apps/web/build.ts:61-68`, точки входа разделов.

- [ ] **Step 1:** `splitting: true` в `Bun.build`. Проверить:
  - чанки попадают в таблицу целостности Service Worker (`HASHED` уже совпадает с `[name]-[hash]`);
  - `index.html` с SRI ссылается только на `main`;
  - CSP `script-src 'self'` чанки пропускает.
- [ ] **Step 2:** ленивые разделы через `import()`: страницы настроек, модалки и пикеры стикеров, редактирование групп, экраны входа (`AuthFlow` только при `boot: 'login'`). Для мгновенного открытия — предзагрузка в простое после первого экрана (`requestIdleCallback`).
- [ ] **Step 3:** иконки VK — в бандл только используемые. Сгенерировать список из кода (`build_vk.py` получает список имён) или оставить полный набор, но в отдельном чанке, загружаемом до первого рендера. Решить по размеру после шага 2.
- [ ] **Step 4: замер:**
  - размер `main` (сырой и brotli);
  - загрузка при ×4 и на телефоне ×6 (время до списка, длинные задачи, самая длинная задача);
  - открытие настроек и пикера стикеров с предзагрузкой — без видимой задержки.
- [ ] **Step 5:** PR.

### Task 12: плашка «Включите уведомления» не становится LCP
- [ ] Показывать плашку в том же кадре, что и список, или резервировать её место с самого начала. Проверка: LCP в трейсе загрузки указывает на элемент списка, а сам список не сдвигается (CLS 0).

---

## Порядок и готовность

1. Исправление 1 (Tasks 1–4) — дёшево, сразу видно.
2. Исправление 3 (Task 6) — плавность перехода.
3. Исправление 2 (Task 5) — эксперимент с замером якоря.
4. Исправление 4 (Tasks 7–9) — три PR подряд.
5. Исправление 5 (Tasks 10–12).

**Готово, когда** на prod-сборке при ×4:
- 10 быстрых переключений дают не больше 2 рывков, а сумма длинных задач — не больше половины базовой (538 мс);
- первое открытие чата — без задач длиннее 100 мс;
- загрузка до списка — быстрее базовой (650 мс) не меньше чем на 20 %;
- строгий DOM — 0 нарушений;
- чек-лист состояния чата из Task 7 пройден.

После каждого PR обновить `docs/perf-audit-2026-10-26.md` строкой «после» и навык `relay-perf` (базовая линия).
