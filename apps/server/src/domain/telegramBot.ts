import { PermanentError } from '../jobs/handlers';
import type { Env } from './codeChannel';

/**
 * Вызов Bot API (TELEGRAM_API_URL — подмена для тестов и ручной проверки). Токен — в адресе запроса, поэтому ни
 * адрес, ни текст ошибки fetch (он бывает с адресом) в лог и в jobs.last_error не попадают.
 * 429 и 5xx, сеть — обычная ошибка (повтор); прочие отказы — PermanentError.
 */
export async function botApi<T = unknown>(method: string, params: object, env: Env = process.env, timeoutMs = 10_000): Promise<T> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new PermanentError('telegram: TELEGRAM_BOT_TOKEN is required');
  const api = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${api}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`telegram: request failed (${e instanceof Error ? e.name : 'error'})`);
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: T } | null;
  if (res.ok && body?.ok) return body.result as T;
  const why = `telegram: ${res.status} ${String(body?.description ?? '').slice(0, 200)}`.trim();
  if (res.status === 429 || res.status >= 500) throw new Error(why);
  throw new PermanentError(why);
}
