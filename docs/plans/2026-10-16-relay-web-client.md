# Relay Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Веб-клиент на Preact и UI-ките Relay: вход, список чатов и лента поверх движка синхронизации в воркере, мгновенный холодный старт из кэша (в том числе без сети), раздача сервером и проверка в Playwright.

**Architecture:** Главный поток держит `GlobalState` — зеркало видимого (список чатов, счётчики, статус синхронизации, лента открытого чата) и состояние интерфейса. Данные приходят патчами подписок из воркера (`EngineClient` + `Mirror`) и применяются в фазе записи кадра (`requestMutation`), несрочные — после тяжёлых анимаций. Рендер Preact идёт через `options.debounceRendering = requestMutation`. Оболочка приложения кэшируется Service Worker'ом, поэтому интерфейс и данные из IndexedDB видны без сети.

**Tech Stack:** Preact 10.29.8 (JSX через Bun), UI-кит Relay (`packages/relay-ui`, twallpaper 2.1.2), `@relay/sync-engine`, Bun.build, Service Worker, Playwright (MCP) для проверки.

## Global Constraints

- Всё в Docker: сервис `web` собирает клиент в `apps/web/dist` (с `--watch` в разработке); `server` раздаёт `dist` и API на одном origin.
- Файлы клиента: `/index.html`, `/main.js`, `/shared.worker.js`, `/dedicated.worker.js`, `/sw.js`, `/relay.css`, `/tokens.css`. Версия сборки `__BUILD__` вшивается во все точки входа и в имя воркера `relay@<build>`.
- API-пути (`/health`, `/me`, `/chats…`, `/ws`, `/dev/…`) никогда не отдаются статикой и не кэшируются Service Worker'ом.
- Статика: путь нормализуется и обязан остаться внутри `dist`; неизвестные пути без расширения → `index.html`.
- Текст сообщений — только текстовые узлы Preact, без `innerHTML`.
- Конфиг движка сериализуемый; в браузере cookie сессии уходит сам.
- Отправка и чтение интерфейсом — только через `engine.call`; интерфейс не ходит в API за данными чатов.

## File Structure

```
apps/server/src/http.ts            + GET /me, раздача статики (serveStatic)
apps/server/src/domain/chats.ts    + peer {id,name} в ChatSummary
apps/server/src/dev/cli.ts         dev: send/read от имени пользователя (для проверки)
apps/server/test/web.test.ts       /me и статика
packages/sync-engine/src/…         + Query 'status', обновление списка при неизвестном чате
packages/relay-ui/                 UI-кит Relay (kit.js, more.js, schedule.js, index.js, relay.css, tokens.css)
apps/web/
  package.json, tsconfig.json, build.ts, public/index.html
  src/main.tsx                     загрузка: /me (или кэш), подключение движка, рендер
  src/global.ts                    GlobalState, setGlobal, useGlobal, рендер раз в кадр
  src/data.ts                      подписки движка → GlobalState
  src/sw.ts                        Service Worker: кэш оболочки
  src/ui/App.tsx, Login.tsx, Sidebar.tsx, Chat.tsx, NewChat.tsx, readTracker.ts
```

## Tasks

### Task 1: Сервер для клиента
- [ ] Тест `web.test.ts`: `GET /me` без сессии → 401, с сессией → `{userId, name}`; при `WEB_DIST` = временная папка с `index.html` и `main.js`: `/` и `/chat/5` → html, `/main.js` → js с `text/javascript`, `/../package.json` → не выходит за папку (404 или index), `/chats` по-прежнему API.
- [ ] Тест в `history.test.ts`: у личного чата `peer = {id, name}` собеседника.
- [ ] Реализация + `dev/cli.ts`. PASS, commit.

### Task 2: Движок — статус и неизвестные чаты
- [ ] Тест: подписка `{kind:'status'}` → `online:false` до connect, `online:true, synced:true` после; `outbox` считает неотправленное.
- [ ] Тест: сообщение в чат, созданный после снимка, → движок подтягивает `/chats`, у чата появляется название (имя собеседника).
- [ ] PASS, commit.

### Task 3: Пакет relay-ui
- [ ] Перенести исходники кита (`kit.js`, `more.js`, `schedule.js`, `index.js`) и `relay.css`; сгенерировать `tokens.css` из `tokens.json` (обе темы, `prefers-color-scheme` + `data-theme`).
- [ ] Сборка `bun build` проходит. Commit.

### Task 4: Веб-клиент
- [ ] `build.ts` (Bun.build: main, два воркера, sw; define `__BUILD__`; копирование html/css), `tsconfig` с `jsxImportSource: preact`.
- [ ] `global.ts`: `setGlobal` копит изменения и рендерит раз в кадр через `requestMutation`; `useGlobal(selector)` с поверхностным сравнением.
- [ ] `data.ts`: подписки `chatList`, `counters`, `status`; при открытии чата — `messages` (лимит растёт при прокрутке вверх).
- [ ] UI: вход (dev), `FloatShell` + `SidebarCard` (`SidebarHeader`, `FolderTabs` «Все / Непрочитанные», `FlipList` + `ChatRow`, `Fab` → новый чат), лента (`GlassBar` + `SyncIndicator`, `Bubble` со статусами, `Composer`, `nudgeWallpaper`), `readTracker` (IntersectionObserver + фокус → `seen`).
- [ ] `sw.ts`: кэш оболочки, навигация — сеть, иначе кэш; API — только сеть.
- [ ] Commit.

### Task 5: Docker и проверка в Playwright
- [ ] Сервис `web` в compose, `server` зависит от сборки; `docker compose up --build`.
- [ ] Playwright: вход Анной, новый чат с Борисом, отправка → `sent`; ответ Бориса через `dev/cli.ts` → строка поднимается, бейдж; открыть чат → бейдж гаснет, у Бориса `last_read_id` вырос; `dev/cli.ts read` → у Анны синие галочки; перезагрузка в офлайне → список и лента из кэша, баннер «Нет сети»; отправка офлайн → часики → сеть → `sent`.
- [ ] Commit, README.
