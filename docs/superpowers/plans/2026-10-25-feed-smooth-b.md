# PR B: анимация удаления (FLIP соседей) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** удалённое сообщение на экране гаснет, соседи доезжают на его место; выше и ниже экрана — как раньше, без анимации.

**Architecture:** буфер «уходящих» в Feed: удалённые из окна строки ещё один рендер рисуются на своих местах (слияние по sort), в layout-эффекте снимаются прямоугольники, уходящая строка выводится из потока (absolute в своей пачке), соседи получают FLIP-transform к новому месту; через 240 мс буфер очищается. Только `transform`/`opacity` (§3.5 SMOOTH-UI), два чтения и две записи в одном `forceMeasure` — осознанное исключение §1 с комментарием.

**Tech Stack:** Preact, Web Animations API (`el.animate`, как в `FlipList`), bun test.

Спек: `docs/superpowers/specs/2026-10-25-feed-smoothness-design.md`, раздел 3.

## Global Constraints

- Только `transform`/`opacity`; высоту не анимируем.
- `reducedMotion()`, `document.hidden`, сдвиг окна (`anchor.current`), `toBottom`, первый кадр — без буфера, обычный путь.
- Уходящая строка инертна: `inert`, `pointer-events: none`, без метки прочтения, вне якорей (`:not(.app-msg-leaving)` в селекторах якорей и перехода).
- Альбом, из которого удалили одно фото, и служебные строки — без анимации (перерисовка на месте).
- Комментарии и строки — по-русски; коммиты с `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `leaving.ts` — чистая логика буфера

**Files:** Create `apps/web/src/ui/leaving.ts`, `apps/web/src/ui/leaving.test.ts`.

**Interfaces (produces):**
- `interiorRemovals(prev: readonly Msg[] | null, next: readonly Msg[]): Msg[]` — удалённые из середины окна (не край окна, не смена окна целиком, не часть живого альбома, не служебные).
- `mergeLeaving(next: readonly Msg[], leaving: Iterable<Msg>): Msg[]` — слияние по `sort`.
- `flipDeltas(first: Map<string, number>, last: Map<string, number>): [string, number][]` — сдвиги строк (|Δ| > 1).
- `LEAVE_MS = 220`, `LEAVE_HOLD_MS = 240`.

- [ ] Тесты: край окна не считается удалением; окно сменилось целиком — пусто; удаление из середины — да; фото из живого альбома — нет; служебное — нет; слияние по sort; дельты.
- [ ] Реализация, тесты зелёные, коммит `feat(feed): leaving.ts — interior removals, merge by sort, FLIP deltas`.

### Task 2: Feed — буфер, рендер уходящих, FLIP-эффект

**Files:** Modify `apps/web/src/ui/Feed.tsx`, `apps/web/public/app.css` (`.app-msg-leaving`), `docs/SMOOTH-UI.md` §4.

- [ ] В блоке `lastWindow` (рядом с `arrivals`): `interiorRemovals(prevList, messages)` → в `leaving.current` (Map key→Item), если можно анимировать (`placed`, нет `anchor`/`toBottom`, не reduced/hidden).
- [ ] `shown` → `mergeLeaving(shown, leaving.current.values())`; Row получает `leaving` → класс `app-msg-leaving`, `inert`, без `app-mark`.
- [ ] `shownKeys` считать по отрисованным строкам (messages + leaving): ветка удаления в главном эффекте срабатывает, когда строка реально уходит из потока.
- [ ] Селекторы `firstVisible`, `viewAnchorOf`, `rowAt`, переход к сообщению — `:not(.app-msg-leaving)`.
- [ ] FLIP-эффект (`useLayoutEffect` после главного): для не сыгранных уходящих — `forceMeasure`: чтение прямоугольников строк в экране ±200 px и `offsetTop/Left/Width` уходящих; уходящие вне экрана — сброс без анимации; запись: уходящие `position:absolute` на своём месте; чтение: новые прямоугольники; запись: `animate` translateY(Δ)→none 220 мс соседям, opacity/scale уходящим; `beginHeavyAnimation(240)`; таймер 240 мс → `viewAnchor` заново → очистить буфер (`setLeaveTick`).
- [ ] CSS: `.app-msg-leaving { pointer-events: none; }`; reduced motion — буфер не создаётся.
- [ ] Тесты web, tsc, коммит.

### Task 3: проверка в браузере (стек на `https://127.0.0.1:<port>`, не `localhost`)

- [ ] Удалить сообщение на экране (своё, через меню) — соседи едут плавно, нет кадра с дырой; удалить выше экрана — экран не дёргается; у низа — строки выше опускаются плавно; удалить два подряд; reduced motion — мгновенно.
- [ ] Сэмплер кадров: кадров > 17 мс нет; шаг соседей монотонный.

### Task 4: ревью дифа и PR (не вливать).
