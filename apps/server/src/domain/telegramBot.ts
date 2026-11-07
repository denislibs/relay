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

/**
 * Файл из Telegram (getFile → скачивание) — байты и тип. Адрес скачивания тоже содержит токен: наружу (браузеру,
 * в лог) уходят только байты. Больше maxBytes — отказ (фото профиля — десятки КБ).
 */
export async function botFile(fileId: string, env: Env = process.env, maxBytes = 2 * 1024 * 1024): Promise<{ bytes: Uint8Array; mime: string }> {
  const f = await botApi<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, env);
  if (!f.file_path || (f.file_size ?? 0) > maxBytes) throw new PermanentError('telegram: file unavailable');
  const api = (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${api}/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(8_000) });
  } catch (e) {
    throw new Error(`telegram: file request failed (${e instanceof Error ? e.name : 'error'})`);
  }
  if (!res.ok) throw new Error(`telegram: file ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new PermanentError('telegram: file too large');
  // тип — по сигнатуре, а не по заголовку: в форму пойдёт только картинка
  const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
    : bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 ? 'image/webp' : '';
  if (!mime) throw new PermanentError('telegram: not an image');
  return { bytes, mime };
}
