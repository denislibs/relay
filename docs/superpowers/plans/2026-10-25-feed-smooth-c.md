# PR C: лесенка появления при открытии чата — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** при открытии чата строки первого экрана появляются снизу вверх лесенкой (10 мс шаг, 200 мс строка), строго после конца перехода стека.

**Architecture:** `reveal.ts` — порядок строк (чистая функция, тесты). В первом кадре ленты (`!placed`) Feed снимает прямоугольники строк (в том же `forceMeasure`, что и позиция), пишет каждой `--reveal` (ступень) и вешает на корень `app-feed-wait` (строки скрыты). По `onHeavyAnimationEnd` (конец перехода стека) класс меняется на `app-feed-reveal` — CSS-анимация с задержкой `calc(var(--reveal) * 10ms)` под собственным `beginHeavyAnimation`; по таймеру класс и переменные снимаются.

Спек: `docs/superpowers/specs/2026-10-25-feed-smoothness-design.md`, раздел 4.

## Global Constraints

- Только `opacity`/`transform`. Reduced motion / `data-anim=0` / скрытая вкладка — без лесенки.
- Не для треда, перехода к сообщению (`focus`), возврата кадра из стека (кадр не перемонтируется — ветка `!placed` не срабатывает), сдвигов окна и дорисовки (`limit`).
- Сдвиг окна и медиа ждут конца лесенки (окно тяжёлой анимации — PR A).

### Task 1: `reveal.ts` + тесты — [ ] написать, [ ] зелёные, [ ] коммит.
### Task 2: CSS (`app.css`: `.app-feed-wait`, `.app-feed-reveal`, `@keyframes app-reveal`, reduced motion) + Feed (первый кадр) — [ ] tsc/тесты, [ ] коммит.
### Task 3: браузер (стек на 127.0.0.1): открыть чат из списка — строки скрыты до конца перехода, затем снизу вверх; кадров > 17 мс нет; возврат из стека и тред — без лесенки; reduced motion — без. [ ] замер.
### Task 4: ревью, PR (не вливать).
