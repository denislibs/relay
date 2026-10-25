# Реакции и анимированные эмодзи как в Telegram: дизайн

Основание: исследование `docs/superpowers/research/2026-10-25-telegram-reactions-emoji.md`
(поведение tweb и tt, без кода — оба GPL). Здесь — что и как делаем в Relay. Пять PR, каждый
в своей ветке, в master только по одобрению.

## Согласованные решения

- Одна реакция от пользователя на сообщение (как Telegram без премиума). Модель данных не меняется.
- Двойной клик остаётся ответом. Hover-кнопку быстрой реакции не делаем.
- Эффект реакции — веб-вариант: `center` 40px поверх иконки + `around` 80px вокруг.
  `activate.tgs` и `effect.tgs` не используем (их веб-клиенты тоже не используют).
- Звуков нет (в ассетах отсутствуют).
- Ряд иконок-групп в поиске полного пикера — из наших категорий эмодзи, не с сервера.
- Ассеты лежат в `apps/server/assets` (вне git). Новые паки, которые ещё докачиваются, с их
  readme — отдельным шагом после этой серии.
- Производительность: `prefs.anim.level 0` или `prefers-reduced-motion` → всё статично
  (webp вместо lottie, без эффектов). Уровни 1 и 2 — всё включено.

## Разбивка

| PR | Ветка | Что |
|---|---|---|
| R1 | `feat/reactions-chips` | Каталог реакций и раздача, нормализация, плашки как в Telegram (внутри с временем, снаружи у медиа, во всех пузырях, аватары, анимация выбора), `onEnded`/`force` в плеере |
| R2 | `feat/reactions-picker` | Быстрая панель из семи с `appear`/`select`, шеврон, полный пикер |
| R3 | `feat/reactions-effects` | Эффект `center`+`around` при своей реакции и при прочтении чужой |
| E1 | `feat/big-emoji` | Сообщение из одного эмодзи — анимированный стикер 112px; 2–7 эмодзи крупным текстом без пузыря |
| E2 | `feat/emoji-interactions` | Клик по большому эмодзи → эффект в личном чате, синхронизация с собеседником |

Зависимости: R2 и R3 после R1; E2 после E1; E1 независим от R*.

---

## Общее: каталоги и раздача (R1, E1)

### Нормализация эмодзи

`packages/protocol/src/emoji.ts`: `emojiKey(s)` — убирает U+FE0F везде и модификаторы тона
U+1F3FB–U+1F3FF, если во всей строке тон один (смешанные тона оставляем). Ключ — для поиска
в каталогах и группировки плашек. В базу эмодзи пишем как прислал клиент, но клиент шлёт
нормализованный `emojiKey` (без FE0F; тон у реакций в каталоге невозможен, у эмодзи-сообщений
тон остаётся в тексте). Серверный regex в `messageOps.ts` остаётся, но допускает FE0F внутри
последовательности (сейчас допускает) и keycap-эмодзи не нужен: реакции только из каталога.

### Каталог реакций

`apps/server/src/reactions/catalog.ts`: при старте читает `ASSETS_DIR/reactions/reactions.json`,
для каждой записи считает `hash8` файлов (через `fileHash8`), строит

```ts
interface ReactionAsset {
  key: string;        // emojiKey
  title: string;      // «Red Heart»
  inactive: boolean;
  static: string;     // /rx/<slug>/<hash8>/static.webp
  appear: string; select: string; center: string | null; around: string | null;   // /rx/… .tgs
}
```

`GET /reactions` → `{ hash: string; items: ReactionAsset[] }`, `ETag = hash` (sha256 содержимого
json + хэши файлов), `cache-control: max-age=3600`. Порядок — как в json (порядок Telegram).
Без ассетов (CI, тесты) — пустой список и `inactive`-поведение клиента: глифы, как сейчас.

Раздача: `files.ts` обобщается до `serveAssetFile(root, pathname, method)`; `/stk/*` → `stickers`,
`/rx/*` → `reactions`. Те же проверки имени и хэша, те же заголовки `immutable`. Service worker:
`/rx/` в тот же cache-first `relay-stickers` (одна функция, список префиксов).

Клиент (`apps/web/src/reactions.ts`): `loadReactions()` один раз за сессию, результат в
`signal<ReactionAsset[]>`; `reactionByKey(key)`; быстрый список `quickReactions(allowed?)`:
семь первых из «недавние (localStorage `relay.reactions.recent`, до 32) → каталог», с учётом
`allowed` группы и без `inactive`. Настройка группы (`group/Reactions.tsx`) показывает каталог
вместо `REACTION_SET`; `QUICK` в `more.js` удаляется.

### Каталог анимированных эмодзи (E1, E2)

`apps/server/src/reactions/emoji.ts` читает `stickers/animated_emoji/meta.json` и
`stickers/emoji_animations/meta.json`, `GET /animated-emoji` →
`{ hash; emoji: Record<key, url>; effects: Record<key, url[]>; generic: url[] }` (цветные сердца
🧡💛💚💙💜🖤🤍🤎 в `effects` маппятся на ❤; `generic` — `emoji_generic_animations`).
Адреса — обычные `/stk/animated_emoji/<hash8>/N.tgs` (папка раздаётся и без импорта в БД).
Около 40 КБ, `ETag`, `max-age=3600`. Клиент: `apps/web/src/animatedEmoji.ts`, загрузка
при первом emoji-only сообщении в окне ленты, до загрузки сообщение показывается текстом
(без мигания: переключение на стикер только после ответа, с кроссфейдом `StickerView`).

### Плеер: `onEnded` и `force` (R1)

`packages/relay-ui/src/lottie/player.js`:
- `attachSticker({... onEnded })` — вызывается один раз, когда `loop` выключен и показан последний
  кадр (в `advance` после `show(total-1)`, после отрисовки). `restart()` сбрасывает флаг.
- `force: true` у вида — `playable()` не смотрит на `isHeavyAnimating()`, `policy.autoplay` и
  `exclusive`; смотрит только на `visible`, `play`, `focused`. Для эффектов и панели меню
  (меню открывается с `beginHeavyAnimation(160)`, иначе `appear` ждал бы конца).
- `StickerView` пробрасывает `onEnded`, `force`, `onFirstFrame`.
Тесты в `player.test.js`: `onEnded` один раз, после `restart` снова; `force` играет при heavy.

---

## R1: плашки реакций

### Данные для плашек

`Feed.tsx` группирует по `emojiKey`: `{ key, emoji, count, mine, users: number[] }`; для поста
канала `users` пустой. Порядок: порядок первого появления в `reactions` (с сервера —
`created_at`), как делает Telegram «как пришло». При локальной своей новой — в конец.

### Разметка

`ReactionChips` в `kit.js` переписывается:

```
div.rl-reacts(.rl-reacts-out .rl-reacts-float)
  button.rl-react(.rl-react-mine)[key=key]
    span.rl-react-icon   ← <img src=static.webp> 22px (или глиф, если каталога нет)
    span.rl-react-n      ← число   | div.rl-react-avatars ← до 3 Avatar 24px
  …
  (meta)                 ← узел времени, последним, только внутри пузыря
```

- Ключ плашки — `key` (эмодзи), не `emoji+count+mine`: узел живёт при смене счётчика.
- `meta` — проп: `Bubble` при наличии реакций не рисует `rl-bubble-meta` и `rl-bubble-spacer`
  отдельно, а передаёт узел меты в `ReactionChips`, который ставит его последним flex-элементом
  с `order:100; margin-left:auto; align-self:flex-end`. Время делит ряд с плашками или уходит
  на свою строку. Класс `rl-bubble-has-react` больше не задаёт `margin-bottom`.
- Порядок детей `Bubble`: меню → fwd → автор → цитата → текст → WebPage → **реакции (+мета)** →
  footer. Footer (комментарии поста) ниже реакций, как в Telegram.
- `.rl-reacts` внутри пузыря — статический блок: `display:flex; flex-wrap:wrap; gap:6px;
  margin:6px 0 0; padding: 0 0 2px`. Абсолютного позиционирования `bottom:-18px` нет.
- Снаружи (`rl-reacts-float`): `MediaBubble` без подписи, `StickerBubble`, `RoundBubble`,
  emoji-only (E1) — блок под медиа в той же обёртке, `justify-content: flex-end` у исходящих,
  `max-width` = ширина медиа (обёртка `width:min-content` уже есть у стикера; у `MediaBubble`
  проверить и добавить). Время остаётся на медиа.
- Внутри: `MediaBubble` с подписью (в подписи, перед метой), `FileBubble`, `VoiceBubble`,
  `MusicBubble`, `TodoBubble` — проп `reactions`/`onReact` добавляется всем, рендер через тот же
  `ReactionChips` с `meta`. В Feed проп передаётся во все ветки `Row`.

### Вид плашки

| Параметр | Значение |
|---|---|
| Высота / скругление | 30px / пилюля |
| Padding | 0 8px 0 6px |
| Иконка | 22×22, `img` static.webp, `draggable=false` |
| Счётчик | 15px/18px, weight 600, `margin-left:6px`, tabular-nums |
| Зазор между плашками | 6px |
| Фон внутри, не моя | `var(--accent-soft)` (in) / out-палитра: `--react-out-soft` |
| Текст не моя | `var(--brand-text)` / `--react-out` |
| Моя | заливка `var(--brand-text)` (out: `--react-out`), текст `#fff` (тёмная тема out: цвет фона пузыря) |
| Снаружи, не моя | `var(--media-scrim)` + `var(--on-media)` |
| Снаружи, моя | in: `var(--brand-text)` + `#fff`; out: `var(--raised)` + `var(--brand-text)` |
| Hover | `::after` цвета «моя» с `opacity:.08`; снаружи — белый `.08`. Без масштаба |
| Выбор | `::before` цвета «моя», `transform:scale(0); opacity:0` → `scale(1); opacity:1` за 300ms cubic-bezier(.4,0,.2,1); цвет текста `transition 300ms` |
| Появление новой плашки | `scale(.6)→1` + opacity 200ms ease-out |
| Исчезновение | без анимации (узел уходит при обнулении count) |
| Отправляемое сообщение (`id == null`) | `pointer-events:none` |

Тема: `--brand-text`, `--accent-soft`, `--raised`, `--media-scrim`, `--on-media` уже есть в `tokens.css`; для
out-акцента завести `--react-out`/`--react-out-soft`, чтобы не зависеть от цвета пузыря.

### Аватары вместо числа

Если `chips` построены из списка (группа или личный чат) и суммарно реакций на сообщении < 4:
вместо числа — `Avatar` 24px до 3 штук в `div.rl-react-avatars` (`flex-direction:row-reverse`,
`margin-left:-14px` у каждого после первого, рамка 2px цвета фона плашки, у «моей» — цвета
заливки). Данные: `users` → `store.users`, недостающие `wantUser` (как в списке чатов). В канале —
всегда число.

### Чтение и клик

Без изменений: клик — toggle через `react()`. Контекстное меню по ПКМ на плашке —
не в этой серии (ограничение: «кто поставил» видно по аватарам при < 4).

### Тесты и проверка

- `packages/protocol`: `emojiKey` (FE0F, тон, смешанные тона).
- `apps/server/test/reactions.catalog.test.ts`: каталог из временной папки, `ETag`, 404 на
  неверный хэш, пустой каталог без папки.
- `apps/web/src/ui/reactions.test.ts`: группировка плашек, порядок, `mine`, `users`.
- Визуально на 127.0.0.1-стеке: текст с 1 и 9 плашками (время переносится), фото без подписи
  (снаружи, справа у своих), голосовое, файл, стикер, пост канала (footer ниже реакций),
  тёмная тема; проверка, что при смене счётчика узел не пересоздаётся (нет анимации появления).

---

## R2: быстрая панель и полный пикер

### Быстрая панель

`ReactionPicker` в `more.js` → `packages/relay-ui/src/reactionsBar.js` (новый файл, экспорт
`ReactionsBar`):

```
div.rl-rbar[role=toolbar](.rl-rbar-ready)
  button.rl-rbar-btn(.rl-rbar-on)  × 7   ← 36×36, внутри StickerView 28px
  button.rl-rbar-more               ← 32×32, chevronDown
  i.rl-rbar-tail                    ← 16×8 полукруг под панелью, справа 20px
```

- Список: `quickReactions(allowed)` из R1, 7 штук. Если каталог пуст — старое поведение
  (глифы), но без hover-масштаба.
- Шеврон — если доступных реакций больше 7 (ровно 8 — показываем 8, как tt).
- Контейнер: высота 40, `border-radius:40px`, `min-width:56px`, padding 0 4px, фон как у
  `.rl-pop .rl-rpick` (blur 50px, 92% `--raised`), `drop-shadow(0 2px 8px rgba(0,0,0,.24))`.
- Положение: `MenuPopover` `header` уже ставит панель над меню; CSS: зазор 8px до меню,
  `margin-right:-40px` (выступ вправо), `max-width: calc(100% + 40px)`. Меню (`place()` в
  `popover.js`) учитывает ширину панели при зажиме в экран: запас справа 40, сверху 48.
- Появление: вместе с меню `scale(.8)→1` + opacity 200ms cubic-bezier(.4,0,.2,1),
  `transform-origin` как у меню. До `rl-rbar-ready` панель `opacity:0`: ready — когда у всех
  семи сработал `onFirstFrame` или прошло 150ms (что раньше).
- Анимация элемента: `StickerView src=appear loop=false force play onEnded=…` → по концу
  монтируется `select` с `play=false` (кадр 0) и `appear` снимается в следующем кадре (без
  мигания: оба слоя в одном боксе, верхний убирается после `onFirstFrame` нижнего).
  `onMouseEnter` → `select.restart()` один раз. Масштаба при hover нет; `:active` scale .9.
- Выбранная (моя) — круг 36px `var(--accent-soft)` под иконкой.
- `prefs.anim.level 0` / reduced motion: `static.webp` без lottie.
- Группа плееров `'menu'`, `force:true`. При закрытии меню все плееры уходят с размонтированием.
- Клавиатура: ← → между реакциями, Enter — выбор, стрелка вниз — в меню (есть у `Menu`).

### Полный пикер

`packages/relay-ui/src/reactionsPanel.js`, экспорт `ReactionsPanel`; в `Chat.tsx` состояние
`rpanel: { x, y, msgId } | null`, открывается из `onMore` панели: берётся
`getBoundingClientRect()` панели, меню закрывается (`setMenu(null)`), панель монтируется
порталом в `body`.

- Размер 382×420 (на ширине < 420 — `calc(100vw - 16px)` по центру), `border-radius:20px`,
  тень `0 5px 10px 5px rgba(16,35,47,.14)`, фон `var(--raised)`.
- Позиция: `left = rect.left − 10.5`, `top = rect.top − 60.5`, зажим в экран с полями 8px.
- Открытие: `scale(.85)→1` + opacity 200ms, `transform-origin: 144px 74px`; закрытие — обратное
  150ms. На время открытия `beginHeavyAnimation(200)`.
- Содержимое:
  1. Поиск: поле 38px с лупой, справа ряд из 8 кнопок-категорий 28×28 (глифы наших категорий
     из `emojiData.ts`: 😀 🐻 🍔 ⚽ 🚗 💡 🔣 🏁, opacity .3, активная .7, gap 7px); при вводе
     текста ряд скрывается (opacity 0, pointer-events none, 150ms); клик по категории
     фильтрует каталог по принадлежности эмодзи к категории, лупа меняется на стрелку «назад».
     Текстовый поиск — `searchEmoji` из `emojiData.ts` (русские ключевые слова) + `title` из
     каталога (латиницей).
  2. Секция без заголовка — первые 16 из `quickReactions`-порядка (недавние вперёд).
  3. «Часто используемые» — остальной каталог.
  4. Пусто → «Ничего не найдено».
- Сетка: `repeat(auto-fill, 42px)`, ячейка 42, иконка 36. Иконка — `static.webp`; на
  `mouseenter` в ячейке монтируется `select` (`play`, loop false, force) и после `onEnded`
  или `mouseleave` снимается. **Отличие от Telegram** (там все `select` крутятся постоянно на
  общем canvas): у нас без shared-canvas это 74 плеера — сознательно не делаем.
- Моя реакция и hover — фон `var(--hover)`, скругление 10px.
- В чате с `mode:'some'` — только `allowed`, без поиска и категорий, высота по контенту
  (до 288px), скругление 20.
- Выбор → `react()` (toggle) + в недавние → закрытие. Закрытие: клик вне, Esc, выбор.
  Пока открыт — `Feed` в режиме блокировки колеса (как у `MenuPopover`).
- Клавиатура: стрелки по сетке, Enter, Esc; фокус в поле поиска при открытии (на touch — нет).

### Тесты и проверка

- `reactionsBar.test.js`: 7 + шеврон, ровно 8 без шеврона, `ready` по 7 первым кадрам или
  150ms, hover перезапускает `select`, уровень 0 → webp.
- `reactionsPanel.test.js`: фильтр по категории и тексту, секции без дублей, клавиатура, зажим в
  экран.
- Визуально: открытие меню у верхнего края экрана и у правого, у своего и чужого сообщения,
  переход панель → пикер, выбор, что меню рядом не дрожит; замер кадров при открытии
  (цель — ни одного кадра > 16ms после первого).

---

## R3: эффект при реакции

### Слой

`apps/web/src/ui/ReactionFx.tsx` + `packages/relay-ui/src/lottie/effects.js`:
один фиксированный слой `div.app-fx` (`position:fixed; inset:0; pointer-events:none;
z-index` между лентой и попапами, `contain:strict`), монтируется в `Chat` один раз.

`playReactionEffect({ iconEl, asset })`:
1. `requestMeasure`: rect иконки плашки. Если не в окне — выход.
2. Создаёт в слое `div.app-fx-item` с двумя canvas: `center` 40×40 (центр по иконке, кадр 0
   рисуется поверх иконки) и `around` 80×80 (тот же центр). Оба `attachSticker({ play:false,
   loop:false, force:true, group:'fx' })`.
3. Когда у обоих `onFirstFrame` — иконке плашки класс `rl-react-icon-hidden` (opacity 0),
   обоим `setPlay(true)` в одном `requestMutation`; `navigator.vibrate?.(100)`.
4. `onEnded` у `center` → в следующем кадре иконка возвращается и `center` снимается;
   `onEnded` у `around` → узел удаляется. Таймаут безопасности 3000ms.
5. На `scroll` ленты — пересчёт позиции (rAF-throttle, `requestMeasure`), при выходе за экран
   — удаление.
- Ограничения: один эффект на плашку (повторный запрос игнорируется), не больше 4 одновременно
  (старший отбрасывается), `prefs.anim.level 0`/reduced motion — нет эффектов.
- Без `around`/`center` у реакции (😂) — только анимация выбора плашки.
- Зеркалирования нет.

### Триггеры

- Своя реакция (плашка, панель, пикер): сразу после оптимистичного обновления, когда
  плашка появилась в DOM (`useLayoutEffect` в `Row` по флагу `fxKey` из глобального
  `pendingFx: Map<msgKey, key>`).
- Чужая реакция на моё сообщение: при прочтении (flush `readReactions` в Feed) — для каждого
  id через 150ms эффект на плашке последней чужой реакции (последний элемент `reactions` не мой).
  Если сообщение не в DOM — пропуск.
- Чужая реакция на чужое сообщение — без эффекта (как Telegram).

### Тесты и проверка

- `effects.test.js`: синхронный старт после двух первых кадров, снятие по `onEnded`, лимит 4,
  повтор на той же плашке игнорируется, таймаут.
- Визуально и замером кадров во время эффекта (цель < 12ms на кадр на M-серии), проверка,
  что лента не дёргается (слой fixed, вне раскладки ленты).

---

## E1: большой эмодзи

### Распознавание

`packages/protocol/src/emoji.ts`: `emojiOnly(body, entities)` → `0` или `{ count, keys[] }`:
нет вложений, нет `entities` (кроме пустых), после удаления `\n` и пробелов текст целиком —
последовательность эмодзи (`Intl.Segmenter` графемы + `\p{Extended_Pictographic}`/keycap);
`count = max(строк, эмодзи в самой длинной строке)`, не больше 100 эмодзи. Чистая функция,
тест с таблицей случаев (тон, ZWJ, флаги, «👍 текст» → 0).

### Рендер

В `Feed.tsx` ветка перед текстовой: `emojiOnly(...)` → `EmojiBubble` (`packages/relay-ui/src/emojiBubble.js`):

- `count === 1` и ключ есть в `animated-emoji` каталоге → `StickerView` 112×112, `loop:false`,
  играет при появлении в окне один раз, стоит на последнем кадре; клик — `restart()`.
  Без фона и хвоста, структура как у `StickerBubble` (`rl-sticker-msg`, head с автором/цитатой,
  `rl-media-chip rl-sticker-meta` — время пилюлей в правом нижнем углу, footer, реакции
  снаружи).
- Иначе (2–7, >7, или нет в каталоге) — тот же контейнер, внутри `span.rl-emoji-text` с
  `font-size` по таблице: 1→112 (статично, если не в каталоге), 2→90, 3→84, 4→72, 5→60, 6→48,
  ≥7→36; `line-height:1.1; white-space:pre-wrap; max-width:420px`; время — пилюля под текстом
  справа (`margin-top:-18px` у меты, как tt `bottom:-1.25rem`).
- Тон кожи: ключ без тона → базовая анимация (перекраски нет; ограничение задокументировать).
- Настройка «Крупные эмодзи» в «Производительность/Вид» (`prefs.bigEmoji`, по умолчанию
  вкл.); выключена → обычный текстовый пузырь.
- Ширина сообщения: `min-width` 112; у 2–7 — по тексту.

### Тесты и проверка

- `emojiOnly` таблица; `EmojiBubble` размеры по count.
- Визуально: 1 (анимированный), 1 (нет в каталоге → статичный 112), 3, 8, с ответом, с
  реакциями, в канале с footer.

---

## E2: интеракции по клику

### Протокол

- WS от клиента: `{ op:'emojiFx'; chatId; id; key; t: number[] }` (`t` — секунды от первого
  клика, ≤ 10 значений, ≤ 10с). Без ответа.
- Сервер (`ws.ts`): только личные чаты (`kind === 'direct'`), участник; пересылает
  второму участнику `{ op:'emojiFx'; chatId; id; key; t; userId }` без записи в журнал.
  Rate: не чаще раза в секунду на (пользователь, чат).
- Движок: как `typing` — эфемерное событие в UI (`onEphemeral('emojiFx', …)`), без стора.

### Клиент

`apps/web/src/ui/EmojiFx.tsx` (в том же слое `app-fx`):

- Клик по `EmojiBubble` (только `count === 1`, анимированный, личный чат, `anim.level ≥ 1`):
  `restart()` стикера + локальный эффект + запись клика в пачку. Пачка закрывается через 1000ms
  после первого клика и уходит одним `emojiFx` (только клики `isTrusted`).
- Эффект: `effects[key]` (случайный из вариантов) или `generic` (случайный, зеркальный,
  loop:false) — div 360×360 в слое: `x = out ? rect.right − 360 : rect.left`, плюс сдвиг
  наружу 16px и случайные ±16 по X, ±4 по Y; `y` — центр по стикеру; у входящих `scaleX(-1)`.
  `attachSticker` `force`, `loop:false`, по `onEnded` узел удаляется; пересчёт на скролл, удаление
  при уходе за экран; `vibrate(100)` на первом кадре. Не больше 3 одновременно.
  На всё время эффекта `beginHeavyAnimation` не вызываем (лента должна оставаться живой).
- Приём: если чат открыт, пузырь в DOM и в окне — для каждого `t` через `t×1000` ms
  симулируется локальный эффект + `restart()`; не отправляется обратно.
- Непрочитанное входящее одиночное эмодзи при первом появлении на экране само запускает
  эффект один раз (как tweb); своё только что отправленное — тоже.

### Тесты и проверка

- Сервер: пересылка только в личном чате, rate-limit, валидация `t`.
- `emojiFx.test.ts`: пачка 1000ms, `t` от первого клика, лимит 3, зеркалирование по `out`.
- Два окна (Chrome 127.0.0.1 + Playwright-профиль): клик в одном → эффект в другом с задержками.

---

## Вне серии

- ПКМ по плашке / попап «кто поставил»; кастомные эмодзи; звуки; тон кожи у анимаций;
  shared-canvas для зацикленных иконок в пикере; новые паки анимаций (после readme).
