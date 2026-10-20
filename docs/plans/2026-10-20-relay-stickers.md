# Анимированные стикеры — план реализации

> **Для исполнителей:** выполнять по задачам (superpowers:subagent-driven-development или superpowers:executing-plans). Шаги — чекбоксы `- [ ]`.

**Цель:** стикеры как в Telegram: анимированные `.tgs` в ленте без пузыря, загрузка силуэтом → превью → анимация без мигания, рендер в воркерах, панель стикеров в композере, модалка стикерпака, правая панель поиска/добавления паков, стикер как ответ на любое сообщение.

**Архитектура:** сервер импортирует `apps/server/assets/stickers` в Postgres (метаданные) и раздаёт файлы как неизменяемую статику; наборы пользователя (установленные, недавние, избранные) живут в журнале обновлений, как черновики и реакции. Клиент рендерит Lottie в пуле воркеров на **tlottie** (Rust → WASM, MIT), кадры приходят `ImageBitmap`, часы и паузы — в нашем планировщике (measure/mutation, heavy animation). Сообщение-стикер несёт снимок стикера (id, пак, эмодзи, размеры, контур), чтобы лента рисовалась без сети.

**Стек:** Bun + Postgres (сервер), sync-engine в SharedWorker + IndexedDB, Preact + relay-ui, tlottie WASM (SIMD / no-SIMD), `DecompressionStream('gzip')`, Service Worker (Cache Storage).

## Global Constraints

- Код telegram-tt и tweb — GPL: переносим только поведение и числа, код пишем сами (clean-room). Рендерер — tlottie из `dkaraush/tlottie` (MIT), WASM собираем из исходников этого репозитория, не берём бинарники из дерева tt/tweb.
- `apps/server/assets` (312 МБ, арт Telegram) **не попадает в git и в Docker-образ**: `.gitignore` + `.dockerignore`, на сервер — volume только для чтения. Репозиторий `denislibs/relay` публичный.
- Плавный UI: никаких вспышек; лоадеры с задержкой показа и минимальным временем; кроссфейды; слой-подложка убирается только после того, как кадр анимации реально на экране.
- Дисциплина DOM: чтения — в `requestMeasure`, записи — в `requestMutation`; strict-dom в dev без нарушений.
- Тесты — в Docker: `docker compose --profile test run --rm test` и `test-engine`; визуальные проверки — покадрово в браузере.
- Ничего не отправлять в настоящие аккаунты мессенджеров при сверке с Telegram — только смотреть.

---

## 1. Что выяснило исследование

### Ассеты Relay (`apps/server/assets`, не в git)
- `stickers/`: 338 паков в `_index.json.order` (+ служебные папки `animated_emoji`, `emoji_animations`, `premium_gifts`, … вне `order`). `meta.json`: `{title, short_name, kind: 'sticker'|'emoji', cover?, stickers: [{file, emoji, path}]}`.
  - 234 стикерпака, 104 эмодзи-пака; 13 215 `.tgs`, 300 `.webp`, 8 `.json` (несжатый Lottie).
  - `.tgs` = gzip Lottie, 512×512, 60 fps, обычно 180 кадров (3 с). `cover.tgs` — обложка пака (у 230 паков).
  - `path` — сжатый векторный контур Telegram («vector thumbnails», документирован в Telegram API) — у 13 273 из 13 523 стикеров.
- `reactions/`: 74 реакции × `static.webp, appear, select, activate, effect, around, center` (`.tgs`) + `reactions.json` (эмодзи, slug, title, premium).
- `telegram/`: обои и темы (не для этого плана).

### Что уже есть в Relay
- `packages/relay-ui/src/sticker.js` — плеер на `@lottiefiles/dotlottie-web` (воркер на инстанс, без учёта heavy animation и настроек); используется только для героев страниц настроек.
- В композере кнопка эмодзи без обработчика (`composer.js:520`), панели эмодзи нет.
- Реакции — текстовые эмодзи; анимированные реакции из ассетов не используются.
- Файлы сообщений идут через `/files/<id>` → 302 на подписанный S3 URL; статику отдаёт nginx из `/srv/dist`, остальное — Bun.
- Правая панель — один слот `AsidePanel` (`App.tsx:62`, флаг `infoOpen`); модалки — `openModal` из `modal.js`.
- Видимость: одноразовый `lazyObserve` (500 px) и постоянный `videoObserve` (threshold 0.5).
- Настройки производительности: `prefs.anim.{autoplayGif, autoplayVideo}`; про стикеры ничего.

### Как это сделано в Telegram (tt и tweb сходятся)
- **Рендер:** оба клиента перешли на **tlottie**. Пул из `min(4, hardwareConcurrency)` воркеров; анимация закреплена за воркером; операции одной анимации идут очередью. Распаковка `DecompressionStream('gzip')` (tt) с лимитом распакованного размера (tweb: 8 МиБ). Кадр: WASM → RGBA → `ImageData` (одна на рендерер) → `createImageBitmap` → основной поток рисует `drawImage`.
- **Общий рендерер:** одинаковый стикер того же размера и DPR = один экземпляр, один кэш кадров, одни часы; удаляется, когда ушло последнее представление. tweb дополнительно направляет одинаковые ключи в один воркер (хэш имени).
- **Качество:** pixel ratio = `clamp(dpr, 1, 2)`, у мелких/второстепенных снижается; мелкие (<100 px) и второстепенные — 30 fps прореживанием кадров, если исходные fps делятся нацело.
- **Кэш кадров:** мелкие (<100 px) — все кадры; крупные — часть (каждый 2-й/4-й не держим); на паузе — оставить только текущий кадр; ушёл из вида — сбросить.
- **Паузы:** только видимые; окно не в фокусе / вкладка скрыта — пауза; во время тяжёлых анимаций интерфейса — пауза и отложенная инициализация; модалка стикерпака — «играет только её группа»; голос/видео могут приостановить всё.
- **Пузырь стикера:** без фона и тени; рамка 200×200 (tweb) / 13 rem ≈ 208 (tt) на десктопе, 180 на мобиле; вписываем по пропорции, пузырь получает min-размер. Время — плашка в правом нижнем углу. Ответ (reply) и имя — плавающие над стикером.
- **Этапы загрузки:** (1) векторный силуэт из `path` (SVG, viewBox по размеру документа, низкая непрозрачность) — мгновенно; (2) растровое превью — сохранённый с прошлого раза первый кадр; (3) анимация; подложка снимается только после подтверждённого показа первого кадра; фейд — только если под ним был лишь силуэт.
- **Цикл:** tweb — стикеры в сообщениях зациклены по умолчанию (настройка «Зацикливать анимированные стикеры»), tt — проигрывает один раз, если настройка выключена. Берём настройку, по умолчанию — цикл.
- **Клик по стикеру** в сообщении → модалка стикерпака.
- **Превью в списке чатов и в ответе:** «😂 Стикер»; в цитате — маленькая картинка стикера (32 px, без анимации).
- **Панель в композере:** вкладки Эмодзи / Стикеры / GIF, снизу — поиск слева и стирание справа. Полоса обложек сверху (Избранное, Недавние, затем паки), синхронизация полосы со скроллом по липким заголовкам. Секции Избранное (лимит 5), Недавние (лимит 20, крестик «очистить»), паки. Ячейка 72 px (68 на мобиле), высота секции резервируется по `count`, наполнение — по видимости, анимации живут только на видимых ячейках. Удержание (125 мс) — увеличенный просмотр 360 px, ведение пальцем/мышью переключает. Обновления «Недавних» во время открытой панели откладываются до закрытия.
- **Поиск стикеров:** строка + быстрые фильтры-эмодзи (сердце, лайк, дизлайк, праздник, улыбка, грусть…); по эмодзи ищем в своих паках, недавних и на сервере; кнопка поиска открывает правую панель.
- **Модалка стикерпака:** ×, название, ⋮ (Скопировать ссылку); сетка 80 px, анимированы и зациклены; плавающая кнопка внизу «ДОБАВИТЬ N СТИКЕРОВ» / «УДАЛИТЬ N СТИКЕРОВ» (красная); пока открыта — анимации вне модалки на паузе; клик по стикеру — отправить в открытый чат.
- **Правая панель «Стикеры»:** поле поиска вместо заголовка; пусто — рекомендуемые паки, текст — поиск по названию; строка пака: название, «N стикеров», кнопка ДОБАВИТЬ/ДОБАВЛЕНО, полоса из 5 анимированных стикеров 68 px; клик по стикеру — отправить, по строке — модалка.
- **Реакции** (на будущее): `static` — до/после анимации и в списках; `appear` — один раз при появлении в меню; `select` — наведение/выбор; `center` — иконка в момент реакции (×1.9), `around` — разлёт вокруг (один раз); `activate`/`effect` в клиентах фактически не используются.

---

## 2. Решения

| Вопрос | Решение | Почему |
|---|---|---|
| Рендерер | tlottie (MIT), WASM SIMD + no-SIMD, собранный из `dkaraush/tlottie` на закреплённом коммите | Быстрее rlottie на 27–70% (бенчмарки автора на 17k анимаций Telegram), его же выбрали tt и tweb; dotlottie остаётся только до задачи 11 |
| Где часы | В основном потоке, в нашем планировщике (`requestMutation`); воркер рендерит на шаг вперёд | Пауза на heavy animation, группы, strict-dom — всё уже у нас в основном потоке |
| Раздача файлов | Bun-маршрут `/stk/…` из `ASSETS_DIR` (read-only volume) + `location` в nginx с теми же заголовками; URL содержит хэш содержимого → `Cache-Control: public, max-age=31536000, immutable` | Файлы публичные и неизменяемые; не тянем 312 МБ в S3 и в образ |
| Метаданные | Импорт в Postgres (`sticker_sets`, `stickers`) скриптом; идемпотентен по хэшу `meta.json` | Поиск, сортировка, права, ссылки из сообщений по id |
| Наборы пользователя | Таблицы + события журнала `stickerSets`, `recentStickers`, `favedStickers` | Офлайн-first и синхронизация вкладок/устройств — как черновики |
| Стикер в сообщении | `kind: 'sticker'` + поле `sticker` (снимок) | Лента рисуется без запросов; пак могут удалить — сообщение живёт |
| Эмодзи-паки (kind emoji), анимированные реакции, большие анимированные эмодзи, GIF | Не в этом плане (раздел 5) | Отдельные фичи поверх того же плеера |

---

## 3. Структура файлов

**Сервер**
- `apps/server/migrations/133_stickers.sql` — `sticker_sets`, `stickers`, `user_sticker_sets`, `recent_stickers`, `faved_stickers`.
- `apps/server/src/stickers/import.ts` — импорт ассетов в БД (CLI + вызов при старте в dev).
- `apps/server/src/stickers/outline.ts` — проверка/нормализация `path` (base64 → байты; декодирование не нужно серверу, только валидация длины).
- `apps/server/src/domain/stickers.ts` — наборы, поиск, установка, недавние, избранное, снимок для сообщения.
- `apps/server/src/http.ts` — маршруты `/api/stickers/*` и статика `/stk/*`.
- `apps/server/src/domain/messages.ts`, `chats.ts`, `push.ts` — новый вид сообщения.
- `docker-compose.yml`, `docker/nginx/dev.conf`, `.gitignore`, `.dockerignore`, `apps/server/Dockerfile`.
- Тесты: `apps/server/test/stickers.test.ts`.

**Протокол**
- `packages/protocol/src/index.ts` — `MessageKind` + `'sticker'`, `StickerRef`, `StickerSet`, события `stickerSets | recentStickers | favedStickers`, кадр `send` с `sticker`, кадры `stickers.*`.
- `packages/protocol/src/groups.ts` — право `stickers` (как «Стикеры и GIF» в Telegram).

**Движок**
- `packages/sync-engine/src/schema.ts` — версия 5: сторы `stickerSets` (по id, с `hash`), `myStickers` (один документ: installed[], recent[], faved[]).
- `packages/sync-engine/src/stickers.ts` — загрузка наборов, кэш, действия.
- `engine.ts`, `store.ts`, `types.ts`, `queries.ts` — новый вид сообщения, запросы `stickerSets`, `myStickers`, действия.
- Тесты: `packages/sync-engine/test/stickers.test.ts`.

**Рендер (relay-ui)**
- `packages/relay-ui/vendor/tlottie/{tlottie.wasm, tlottie-no-simd.wasm, LICENSE, BUILD.md}` + `docker/tlottie.Dockerfile` (сборка из исходников).
- `packages/relay-ui/src/lottie/worker.js` — воркер: загрузка WASM, рендереры, кэш кадров.
- `packages/relay-ui/src/lottie/pool.js` — пул воркеров, маршрутизация по ключу, протокол.
- `packages/relay-ui/src/lottie/player.js` — общий проигрыватель (часы, представления-канвасы, группы, паузы).
- `packages/relay-ui/src/lottie/outline.js` — декодер контура → SVG path.
- `packages/relay-ui/src/lottie/previews.js` — сохранённые первые кадры (Cache Storage).
- `packages/relay-ui/src/StickerView.js` — компонент: силуэт → превью → анимация.
- Тесты: `packages/relay-ui/src/lottie/*.test.js`.

**Веб**
- `apps/web/src/ui/stickers/SymbolMenu.tsx` (панель композера), `StickerGrid.tsx`, `EmojiTab.tsx`, `StickerPreview.tsx` (удержание), `StickerSetModal.tsx`, `StickersPanel.tsx` (правая панель).
- `apps/web/src/ui/Feed.tsx`, `preview.tsx`, `Chat.tsx`, `App.tsx`, `global.ts`, `prefs.ts`, `ui/settings/Performance.tsx`, `apps/web/src/sw.ts`, `apps/web/build.ts`.

---

## 4. Задачи

### Задача 0. Ассеты вне git и образа, раздача статики

**Файлы:** `.gitignore`, `.dockerignore`, `docker-compose.yml`, `apps/server/Dockerfile`, `docker/nginx/dev.conf`, `apps/server/src/http.ts`, тест `apps/server/test/stickers.test.ts`.

**Интерфейсы:**
- Даёт: `ASSETS_DIR` (env, по умолчанию `/assets`), маршрут `GET /stk/<pack>/<hash8>/<file>` (`hash8` — первые 8 hex sha256 файла; неверный хэш → 404).

- [x] Добавить `apps/server/assets/` в `.gitignore` и `.dockerignore`; проверить `git status` — ассеты исчезли из неотслеживаемых.
- [x] `docker-compose.yml`: в dev отдельный volume не нужен — сервер видит `apps/server/assets` через смонтированный `./apps`; `ASSETS_DIR` по умолчанию — `apps/server/assets` рядом с кодом. Для образа без ассетов (prod) — volume и `ASSETS_DIR`.
- [x] Тест: `GET /stk/utyaduck/<верный hash8>/1.tgs` → 200, `content-type: application/x-tgsticker`, `cache-control: public, max-age=31536000, immutable`, тело совпадает с файлом; неверный хэш → 404; `..` в пути → 400; без сессии — отдаётся (стикеры публичные).
- [x] Реализовать маршрут в Bun (путь не выходит за `ASSETS_DIR`, как в `serveStatic`).
- [x] nginx: **отдельный location не нужен** — `/stk/…` нет в сборке, `location /` уже передаёт его в `@api`, заголовки Bun доходят как есть. Алиас в nginx отдавал бы файл без сверки хэша и мог бы навсегда закэшировать подменённый файл под старым адресом.
- [x] Тесты зелёные, коммит `chore(stickers): keep Telegram assets out of git and the image, serve them as immutable static`.

### Задача 1. tlottie: сборка WASM и замер

**Файлы:** `docker/tlottie.Dockerfile`, `packages/relay-ui/vendor/tlottie/*`, `scratchpad` для замера.

- [x] `docker/tlottie.Dockerfile`: `rust` образ, `rustup target add wasm32-unknown-unknown`, клон `dkaraush/tlottie` на закреплённом коммите (зафиксировать sha в `BUILD.md`), две сборки (`+simd128` и `-simd128`) с профилем и фичами из README репозитория; результат — `tlottie.wasm`, `tlottie-no-simd.wasm`.
- [x] Положить бинарники, `LICENSE` из репозитория tlottie и `BUILD.md` (как пересобрать) в `packages/relay-ui/vendor/tlottie/`.
- [x] Изучить C/WASM API по `include/tlottie.h` и `examples/web` **репозитория tlottie** (MIT); записать в `BUILD.md` список экспортов, которые используем (выделение памяти, создание рендерера из JSON, число кадров/fps/размер, рендер кадра в RGBA, освобождение).
- [x] Замер в браузере (страница в scratchpad): 20 случайных стикеров из ассетов, 512→200 px при DPR 2 (400 px), среднее и p95 мс/кадр для tlottie SIMD, no-SIMD и текущего dotlottie. Критерий: tlottie SIMD p95 < 4 мс/кадр на этом Mac. Результат — таблица в `BUILD.md`.
- [x] Коммит `build(ui): tlottie WASM built from source (MIT), with benchmark`.

### Задача 2. Воркер и пул рендеринга

**Файлы:** `packages/relay-ui/src/lottie/worker.js`, `pool.js`, тест `pool.test.js`; `apps/web/build.ts` (entry воркера, копирование WASM).

**Интерфейсы (даёт):**
```ts
// pool.js
openRenderer(key: { url: string; px: number; tone?: number }): Promise<RendererHandle>
type RendererHandle = { frames: number; fps: number; step: number /* прореживание */;
  frame(i: number): Promise<ImageBitmap>; release(): void }
```

- [x] Воркер: детект SIMD (валидация крошечного модуля), `WebAssembly.instantiateStreaming` с откатом на `arrayBuffer`.
- [x] Загрузка: `fetch(url)` (идёт через SW-кэш, задача 6), `DecompressionStream('gzip')` с подсчётом байтов и обрывом > 8 МиБ (защита от zip-бомбы); `.json` — без распаковки.
- [x] Рендерер на ключ `url|px|tone` в воркере, одна `ImageData` на рендерер, ответ `ImageBitmap` (transfer).
- [x] fps: кап 60; `px < 100` → кап 30 прореживанием, если исходные fps делятся нацело (`step = src/cap`), иначе `step = 1`.
- [x] Кэш кадров в воркере: `px < 100` — все кадры; иначе держим кадры с `i % 4 !== 0` (≈75%); команда `trim(keepFrame)` — оставить один кадр (пауза); `drop()` — всё.
- [x] Очередь операций на рендерер (init → frame → release не перемешиваются); поздние ответы после `release` закрываются (`bitmap.close()`).
- [x] Пул: `min(4, hardwareConcurrency || 4)` модульных воркеров, создаются лениво; ключ → воркер по хэшу ключа (одинаковые стикеры в одном воркере, общий кэш); счётчик ссылок на рендерер в пуле, `release` последнего — `destroy` в воркере.
- [x] Тест (bun test + happy-dom не умеет WASM → тест протокола на фейковом воркере): двойной `openRenderer` с одним ключом даёт один рендерер; `release` дважды → один `destroy`; маршрутизация ключа стабильна.
- [x] Ручная проверка в браузере: 50 одинаковых стикеров → 1 рендерер; 50 разных → распределены по 4 воркерам.
- [x] Коммит `feat(ui): lottie worker pool on tlottie — shared renderers, cache-affine routing, frame cache tiers`.

### Задача 3. Проигрыватель, контур, превью, компонент `StickerView`

**Файлы:** `packages/relay-ui/src/lottie/player.js`, `outline.js`, `previews.js`, `packages/relay-ui/src/StickerView.js`, `relay.css`, тесты `outline.test.js`, `player.test.js`.

**Интерфейсы (даёт):**
```ts
decodeOutline(b64: string): string                     // SVG path "M…z"
<StickerView src outline w h size loop play group onClick />  // size — сторона рамки в CSS px
setStickerGroupExclusive(group: string | null): void    // «играет только эта группа»
setStickerPolicy({ autoplay: boolean; loop: boolean }): void
```

- [x] `outline.js` по публичной спецификации Telegram «vector thumbnails»: байт ≥ 192 — символ из таблицы команд/цифр (индекс `b − 192`), 128..191 — `,` + `b & 63`, 64..127 — `-` + `b & 63`, < 64 — число; результат в `M…z`. Тест на известном векторе (взять `path` первого стикера `utyaduck`, сверить, что путь парсится браузерным `Path2D` без ошибок и bbox внутри 512×512).
- [x] `player.js`: один «проигрыватель» на ключ (общие часы для всех одинаковых стикеров на экране) с набором представлений (канвасов). Часы — `requestMutation` по rAF: индекс кадра от реального времени (на слабом устройстве пропускаем кадры, скорость сохраняется); кадр запрашивается на один вперёд; нет кадра — ждём, не дёргаем.
- [x] Гейты паузы: невидим (общий IntersectionObserver, threshold 0); `document.hidden` / окно без фокуса; `isHeavyAnimating()` (и инициализация откладывается до `onHeavyAnimationEnd`); группа не равна эксклюзивной; `reducedMotion()` или политика `autoplay: false` → статичный первый кадр. На паузе — `trim` до текущего кадра; ушёл из вида на паузе — `drop`.
- [x] Цикл: `loop` из политики; иначе один проход и остановка на последнем кадре; повторный показ — снова один проход.
- [x] `previews.js`: после первого показанного кадра сохраняем его PNG в Cache Storage `relay-sticker-previews` (ключ `url|px`), не больше 64 записей/8 МиБ в памяти (LRU object URL), на диске — по квоте; при открытии — превью сразу.
- [x] `StickerView`: рамка `size×size`, стикер вписан по пропорции `w/h`. Слои: SVG-силуэт (`fill: currentColor`, `opacity: .1`) → `<img>` превью (показ после `img.decode()`) → `<canvas>`. Подложка снимается, когда кадр нарисован и прошли два rAF; фейд канваса 200 мс — только если под ним был лишь силуэт; если было превью — без фейда (кадры совпадают).
- [x] Тест плеера на фейковом пуле: два `StickerView` с одним `src` → один `openRenderer`; размонтирование обоих → `release`; невидимый не запрашивает кадры.
- [x] Проверка в браузере покадрово: силуэт виден с первого кадра, нет белой вспышки при смене слоёв, strict-dom чистый.
- [x] Коммит `feat(ui): StickerView — outline, saved first frame, worker-rendered animation with shared clocks and play gates`.

### Задача 4. Сервер: паки, наборы пользователя, сообщение-стикер

**Файлы:** `apps/server/migrations/133_stickers.sql`, `apps/server/src/stickers/import.ts`, `apps/server/src/domain/stickers.ts`, `messages.ts`, `chats.ts`, `push.ts`, `ws.ts`, `http.ts`, `packages/protocol/src/{index,groups}.ts`, тест `apps/server/test/stickers.test.ts`.

**Схема:**
```sql
create table sticker_sets (id bigserial primary key, short_name text unique not null, title text not null,
  kind text not null check (kind in ('sticker','emoji')), position int not null, count int not null,
  cover_sticker_id bigint, cover_file text, hash text not null);
create table stickers (id bigserial primary key, set_id bigint not null references sticker_sets on delete cascade,
  idx int not null, file text not null, file_hash text not null, format text not null check (format in ('tgs','webp','json')),
  emoji text not null, w int not null, h int not null, outline text, unique (set_id, idx));
create index stickers_emoji on stickers (emoji);
create table user_sticker_sets (user_id bigint references users on delete cascade, set_id bigint references sticker_sets on delete cascade,
  position int not null, added_at timestamptz not null default now(), primary key (user_id, set_id));
create table recent_stickers (user_id bigint references users on delete cascade, sticker_id bigint references stickers on delete cascade,
  used_at timestamptz not null default now(), primary key (user_id, sticker_id));
create table faved_stickers (user_id bigint references users on delete cascade, sticker_id bigint references stickers on delete cascade,
  faved_at timestamptz not null default now(), primary key (user_id, sticker_id));
```

**Протокол (даёт):**
```ts
type StickerRef = { id: number; setId: number; emoji: string; w: number; h: number;
  format: 'tgs' | 'webp' | 'json'; url: string /* /stk/<pack>/<hash8>/<file> */; outline: string | null };
type StickerSetInfo = { id: number; shortName: string; title: string; kind: 'sticker' | 'emoji'; count: number;
  cover: StickerRef | null; hash: string };
type StickerSet = StickerSetInfo & { stickers: StickerRef[] };
// Message: kind 'sticker', sticker: StickerRef
// ClientFrame send: sticker?: { id: number }  (взаимоисключимо с body/attachment; replyToId — любой)
// Update: { type: 'stickerSets'; installed: number[] } | { type: 'recentStickers'; ids: number[] } | { type: 'favedStickers'; ids: number[] }
// ClientFrame: stickers.install {setId} | stickers.uninstall {setId} | stickers.reorder {ids} | stickers.fave {id, on} | stickers.clearRecent
```

**HTTP:** `GET /api/stickers/sets/:idOrShortName` (полный набор, ETag = hash); `GET /api/stickers/featured?offset` (по `position`, 20 на страницу); `GET /api/stickers/search?q=` (название/short_name, ILIKE + pg_trgm); `GET /api/stickers/by-emoji?e=` (до 100: свои паки → недавние → остальные); `GET /api/stickers/mine` (installed, recent, faved — снимок для холодного старта).

- [x] Тесты (сначала падают): импорт фикстуры из 2 паков в `/tmp` идемпотентен (второй прогон ничего не меняет, изменение `meta.json` обновляет `hash`); `w/h` для `.tgs` берутся из JSON, для `.webp` — из заголовка VP8/VP8L/VP8X; стикер без `path` → `outline null`.
- [x] Тесты домена: install/uninstall/reorder пишут событие `stickerSets` в журнал владельца; recent: отправка стикера поднимает его в начало, лимит 20; faved: лимит 5 (шестой вытесняет самый старый); clearRecent.
- [x] Тесты сообщения: `send {sticker:{id}}` → `kind 'sticker'`, снимок `StickerRef` в `messages.sticker` (jsonb, новая колонка в той же миграции), `body` пустой; ответ стикером на фото/голос/стикер работает; несуществующий стикер → `not_found`; в группе без права `stickers` → `forbidden`; пересылка копирует снимок; превью push «😂 Стикер»; поиск по сообщениям стикеры не находит.
- [x] Реализация; импорт запускается командой `bun apps/server/src/stickers/import.ts` и в dev-старте сервера, если `sticker_sets` пуст.
- [x] Новому пользователю устанавливаются первые 8 паков из `_index.json.order` (чтобы панель не была пустой) — одной транзакцией при регистрации.
- [x] Коммит `feat(server): sticker packs from assets, per-user sets/recent/faved in the journal, sticker messages`.

### Задача 5. Движок: офлайн-наборы и отправка стикера

**Файлы:** `packages/sync-engine/src/{schema,types,store,engine,queries,stickers}.ts`, тест `packages/sync-engine/test/stickers.test.ts`.

**Интерфейсы (даёт):**
```ts
Query: { kind: 'myStickers' } | { kind: 'stickerSet'; id: number }
Action: { type: 'sendSticker'; chatId: number; stickerId: number; replyToId?: number | null }
      | { type: 'installStickerSet' | 'uninstallStickerSet'; setId: number }
      | { type: 'faveSticker'; id: number; on: boolean } | { type: 'clearRecentStickers' }
      | { type: 'searchStickerSets'; q: string } | { type: 'stickersByEmoji'; emoji: string } | { type: 'featuredStickerSets'; offset: number }
LocalMessage: kind 'sticker', sticker?: StickerRef
```

- [x] Тесты: `myStickers` отдаёт installed/recent/faved из IDB без сети; событие журнала обновляет; `stickerSet` — из кэша, при несовпадении `hash` перезапрашивает; `sendSticker` офлайн → черновое сообщение со снимком из кэша набора, уходит при сети, ack без дублей; недавние обновляются локально сразу (оптимистично) и сходятся с сервером.
- [x] `SCHEMA_VERSION = 5`, сторы `stickerSets`, `myStickers`; `applyMessage` копирует `sticker`; outbox кадр `send` несёт `sticker`.
- [x] Коммит `feat(engine): sticker sets and my stickers offline, sendSticker through the outbox`.

### Задача 6. Кэш файлов в Service Worker

**Файлы:** `apps/web/src/sw.ts`.

- [x] `/stk/*` — cache-first в отдельный кэш `relay-stickers` (не сбрасывается при новой сборке); лимит 150 МБ (по `navigator.storage.estimate` и счётчику), вытеснение старых записей по времени последнего чтения (метка в IDB SW).
- [x] WASM tlottie — в shell-кэш сборки.
- [x] Проверка: второй показ пака без сети — анимации играют.
- [x] Коммит `feat(web): stickers cached by the service worker apart from the app shell`.

### Задача 7. Стикер в ленте, в ответах и в списке чатов

**Файлы:** `apps/web/src/ui/Feed.tsx`, `preview.tsx`, `Chat.tsx`, `packages/relay-ui/src/kit.js` (`StickerBubble`), `relay.css`.

- [x] `StickerBubble`: без фона и тени; рамка 200 px (180 при ширине < 600), вписывание по пропорции; плашка времени/статуса в правом нижнем углу (стиль как `rl-media-chip-meta`); ответ (цитата) и имя автора в группе — плавающая карточка над стикером; реакции — под стикером, как у медиа.
- [x] `Feed.tsx`: ветка `kind === 'sticker'` до текстового `Bubble`; клик по стикеру — модалка пака (задача 9); контекстное меню как у медиа без «Изменить».
- [x] Цитата ответа на стикер: `quoteContent` → текст «😂 Стикер», `thumbSrc` — сохранённое превью или силуэт (32 px, без анимации).
- [x] Список чатов и push: «😂 Стикер».
- [x] Ответ стикером на любое сообщение — через обычный `replyToId`; проверить ответ стикером на текст, фото, голос, кружок, стикер.
- [x] Проверка в браузере (два контекста): отправка, получение, силуэт → превью → анимация без мигания; прокрутка ленты с 30 стикерами — играют только видимые (счётчик активных рендереров ≤ видимых), strict-dom чистый.
- [x] Коммит `feat(web): sticker messages — bubble-less, floating reply, quote and list previews`.

### Задача 8. Панель эмодзи и стикеров в композере

**Файлы:** `apps/web/src/ui/stickers/{SymbolMenu,StickerGrid,EmojiTab,StickerPreview}.tsx`, `packages/relay-ui/src/composer.js` (обработчик кнопки), `relay.css`.

- [x] Открытие: клик по кнопке эмодзи и наведение (как у меню вложений); всплывает над композером справа, 420×(высота до 420), появление `rl-menu-in`; закрытие — клик вне, Esc, отправка стикера.
- [x] Нижняя полоса: поиск (слева, открывает правую панель «Стикеры»), вкладки Эмодзи / Стикеры (GIF — неактивна до отдельной фичи), стереть (справа, только на вкладке Эмодзи). Переключение вкладок — `SlideStack`.
- [x] Вкладка Эмодзи: категории Unicode (недавние, смайлы, люди, животные, еда, путешествия, занятия, предметы, символы, флаги), полоса категорий сверху, вставка в поле ввода в позицию курсора; недавние эмодзи — `localStorage`.
- [x] Вкладка Стикеры: верхняя полоса — Избранное (закладка), Недавние (часы), обложки установленных паков (`StickerView` 32 px, без автопроигрывания); под ней поиск + быстрые фильтры ❤️ 👍 👎 🎉 😀 😢 😡 😴 (выбор → `stickersByEmoji`, назад — стрелка).
- [x] Секции: Избранное, Недавние (× → подтверждение «Очистить недавние?»), паки по порядку; высота секции резервируется по `count` и числу колонок (ширина / 72 px); ячейки наполняются при приближении (500 px), анимируются только видимые; липкие заголовки синхронизируют полосу обложек (активная — по центру), клик по обложке — плавный скролл к секции.
- [x] Клик по стикеру — `sendSticker` с текущим ответом (если выбран), панель закрывается; ПКМ — меню: В избранное / Убрать из избранного, Убрать из недавних, Открыть пак.
- [x] Удержание 125 мс (мышь/палец) — `StickerPreview`: стикер 360 px поверх затемнения, эмодзи под ним, вход 200 мс от рамки ячейки; ведение по другим ячейкам переключает; отпускание закрывает; пока открыт — эксклюзивная группа.
- [x] Изменения «Недавних» во время открытой панели применяются после закрытия (сетка не перестраивается под курсором).
- [x] На время анимации открытия — `beginHeavyAnimation`: стикеры стартуют после неё.
- [x] Проверка в браузере: открытие без рывка, полоса следует за скроллом, 50+ паков листаются плавно (нет длинных задач > 50 мс), strict-dom чистый.
- [x] Коммит `feat(web): emoji and sticker panel in the composer`.

### Задача 9. Модалка стикерпака

**Файлы:** `apps/web/src/ui/stickers/StickerSetModal.tsx`, `relay.css`.

- [x] `openStickerSet(idOrShortName)` из ленты, панели, правой панели; заголовок: ×, название (пока грузится — «Загрузка…» с задержкой показа 200 мс), ⋮ → «Скопировать ссылку» (`/addstickers/<short_name>` — открывает модалку при переходе).
- [x] Сетка 80 px (68 на мобиле), 5 колонок, стикеры анимированы и зациклены, эксклюзивная группа `modal` (всё остальное на паузе), удержание — `StickerPreview`.
- [x] Плавающая кнопка-пилюля внизу: «ДОБАВИТЬ N СТИКЕРОВ» (акцент) / «УДАЛИТЬ N СТИКЕРОВ» (красный текст на светлой пилюле, как на референсе); склонения; во время запроса — неактивна; после — модалка закрывается, тост «Набор добавлен/удалён».
- [x] Клик по стикеру — отправить в открытый чат и закрыть.
- [x] Коммит `feat(web): sticker set modal`.

### Задача 10. Правая панель «Стикеры» (поиск и добавление паков)

**Файлы:** `apps/web/src/ui/stickers/StickersPanel.tsx`, `App.tsx`, `global.ts` (`aside: 'info' | 'stickers' | null` вместо одного `infoOpen`, с миграцией мест, где читается `infoOpen`).

- [x] Шапка: ← и поле «Поиск стикеров» вместо заголовка; пусто — рекомендуемые (`featured`, догрузка страницами при приближении к низу на 500 px), текст — поиск с задержкой 250 мс и минимальным временем показа лоадера.
- [x] Строка пака: название (крупно), «N стикеров», кнопка ДОБАВИТЬ (акцент) / ДОБАВЛЕНО (серая), полоса из 5 стикеров 68 px (анимированы, группа `panel`); клик по стикеру — отправить, по строке — модалка.
- [x] Открывается из поиска в панели композера; Esc закрывает; открытие/закрытие — как у «Информации» (FLIP колонки чата).
- [x] Коммит `feat(web): stickers side panel — featured and search with add buttons`.

### Задача 11. Настройки и перевод героев настроек на новый плеер

**Файлы:** `apps/web/src/prefs.ts`, `ui/settings/Performance.tsx`, места использования `packages/relay-ui/src/sticker.js`, `packages/relay-ui/package.json`.

- [x] `prefs.anim.stickers: { autoplay: boolean; loop: boolean }` (по умолчанию `true/true`; уровень анимаций 0 → `false/false`); раздел «Стикеры» в «Производительности»: «Автовоспроизведение стикеров», «Зацикливать анимированные стикеры»; изменение применяется к живым стикерам сразу (`setStickerPolicy`).
- [x] Герои страниц настроек переходят на `StickerView`; `sticker.js` и зависимость `@lottiefiles/dotlottie-web` удаляются, `dotlottie-player.wasm` убирается из shell.
- [x] Коммит `feat(web): sticker autoplay/loop settings; one lottie player for the whole app`.

### Задача 12. Приёмка

- [x] Все тесты (`test`, `test-engine`, тесты relay-ui) зелёные.
- [x] Сценарий в двух браузерных контекстах: открыть панель → отправить стикер из Недавних → собеседник видит силуэт → анимацию; ответить стикером на голосовое; открыть пак кликом по стикеру, добавить его; найти пак в правой панели, добавить, он появился в полосе панели композера во второй вкладке того же пользователя без перезагрузки.
- [x] Производительность: лента с 40 стикерами на экране — 60 fps при прокрутке (Performance trace без длинных задач > 50 мс в основном потоке), не больше 4 воркеров, память рендереров падает после ухода стикеров из вида.
- [x] Офлайн: перезагрузка без сети — лента со стикерами играет из кэша SW, отправка стикера уходит в очередь.

---

## Итог (2026-10-20)

Все задачи сделаны и закоммичены в master. Где разошлись с планом — и почему:

- **Кэш кадров — в основном потоке** (pool.js), а не в воркере: переданный ImageBitmap в воркере уже не используешь, а две копии — лишняя память (так же у tt). Некэшируемые кадры закрываются после показа, следующий кадр рисуется заранее.
- **Действия с паками — HTTP + очередь операций движка**, а не новые кадры WebSocket; журнал несёт один сигнал `{type:'myStickers'}`, клиент перечитывает `/my-stickers`. Неподтверждённые свои изменения накладываются на ответ сервера — кнопки не «мигают» назад.
- **nginx без отдельного location для /stk** — запрос и так уходит в Bun, который сверяет хэш; алиас отдавал бы файл без проверки.
- **Мои стикеры и паки — в meta IndexedDB**, без новой версии схемы.
- **Отдельное право группы «Стикеры и GIF»** (`stickers`, входит в «Медиа»).
- **GIF-вкладка** — неактивна до отдельной фичи; эмодзи-вкладка — Unicode-категории и недавние.

Приёмка: сервер 343/343, движок 257/257, веб 203/203, relay-ui 46/46; в браузере (два контекста) — силуэт → анимация у получателя без пустых кадров, модалка, синхронизация паков между вкладками, 40 стикеров без длинных задач, офлайн из кэша SW.

## 5. Не в этом плане (следующие шаги поверх того же плеера)

- **Анимированные реакции** из `assets/reactions`: `appear` в меню реакций, `select` на наведении, `center` + `around` в момент реакции, `static` в чипах и списках.
- **Большие анимированные эмодзи:** сообщение из одного эмодзи → стикер из `animated_emoji`; 2–7 эмодзи — крупный текст (96 → 36 px по количеству).
- **Эмодзи-паки (kind emoji)** как кастомные эмодзи в тексте и общий канвас для сеток мелких анимаций.
- **GIF-вкладка.**
- **Эффекты премиум-стикеров** и рекомендации стикеров по эмодзи при наборе текста.
