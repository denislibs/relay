/**
 * «Слишком часто» (flood, как FLOOD_WAIT в Telegram): сервер и nginx отвечают {code: 'flood', retryAfter} — секунд
 * до повтора (apps/server/src/domain/flood.ts, docs/protection.md). Здесь — разбор и текст для человека.
 */

/** «через 40 с», «через 3 мин», «через 2 ч». */
export function waitText(sec: number): string {
  const s = Math.max(1, Math.ceil(sec));
  if (s < 60) return `через ${s} с`;
  if (s < 3600) return `через ${Math.ceil(s / 60)} мин`;
  return `через ${Math.ceil(s / 3600)} ч`;
}

/** Ошибка вызова движка — flood? Секунд ожидания (0 — сервер не сказал), иначе null. Формат — host-core.errorText. */
export function floodWait(err: unknown): number | null {
  const e = err as { code?: unknown; retryAfter?: unknown } | null;
  if (e?.code === 'flood') return Number(e.retryAfter) || 0;
  const m = /^flood(?::(\d+))?$/.exec(String((err as Error)?.message ?? ''));
  return m ? Number(m[1] ?? 0) : null;
}

/** Текст тоста: «Слишком часто. Попробуйте через 12 с». */
export function floodText(sec: number | null | undefined, what = 'Слишком часто'): string {
  return sec ? `${what}. Попробуйте ${waitText(sec)}` : `${what}. Попробуйте позже`;
}

/** Ответ 429 (сервер или nginx): секунд ожидания из тела {retryAfter} или заголовка Retry-After; 0 — не сказали. */
export async function httpWait(res: Response): Promise<number> {
  const j = (await res.clone().json().catch(() => null)) as { retryAfter?: unknown } | null;
  return Number(j?.retryAfter ?? res.headers.get('retry-after')) || 0;
}
