/**
 * Лесенка появления при открытии чата (как в Telegram): строки первого экрана появляются снизу вверх с шагом
 * 10 мс, каждая — 200 мс (opacity + лёгкий scale). Только первый кадр чата и только после конца перехода стека:
 * до него строки скрыты классом app-feed-wait, потом app-feed-reveal запускает анимацию (CSS в app.css).
 * Здесь — чистая часть: порядок строк.
 */
export const REVEAL_MS = 200;        // одна строка
export const REVEAL_STEP_MS = 10;    // шаг лесенки
export const REVEAL_MAX = 24;        // ступеней не больше, чем строк первого экрана (FIRST_PAINT)

export type RowBox = { key: string; top: number; bottom: number };

/** Порядок появления: видимые строки снизу вверх — 0, 1, 2…; вне экрана — 0 (не ждут, их не видно). */
export function revealOrder(rows: readonly RowBox[], viewTop: number, viewBottom: number): Map<string, number> {
  const visible = rows.filter((r) => r.bottom > viewTop && r.top < viewBottom).sort((a, b) => b.top - a.top);
  const out = new Map<string, number>();
  visible.forEach((r, i) => out.set(r.key, Math.min(i, REVEAL_MAX)));
  return out;
}

/** Сколько длится вся лесенка для steps ступеней. */
export const revealTotalMs = (steps: number): number => REVEAL_MS + Math.max(0, Math.min(steps, REVEAL_MAX) - 1) * REVEAL_STEP_MS;
