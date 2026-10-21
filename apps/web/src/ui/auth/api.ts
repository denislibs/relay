/** Вызовы /auth/*: ответ — данные или код ошибки сервера ('offline' — нет сети). */
import { bindProof, type DeviceProof } from '@relay/sync-engine/src/device';

/**
 * Шаги, после которых может появиться сеанс (и QR/паскей, чей вызов привязан к устройству): к ним — ключ устройства
 * с подписью (device.ts: bindProof). Сеанс создаётся привязанным — его cookie без ключа бесполезен с первого запроса.
 */
const DEVICE_STEPS = new Set(['/auth/signin', '/auth/signup', '/auth/password/check', '/auth/password/recover/check', '/auth/qr', '/auth/qr/poll', '/auth/passkey/options', '/auth/passkey/finish']);
/** Ключ недоступен (IndexedDB или WebCrypto выключены) — вход как раньше, сеанс привяжется при первом обновлении доступа. */
const proofFor = (path: string): Promise<DeviceProof | null> => (DEVICE_STEPS.has(path) ? bindProof().catch(() => null) : Promise.resolve(null));

export type Step =
  | { userId: number }
  | { passwordNeeded: true; pendingId: string; hint: string }
  | { signupRequired: true; pendingId: string };

export type Result<T> = { ok: true; data: T } | { ok: false; code: string };

/** Прокси (nginx) не достучался до API — 502/503 без нашего JSON: сервер перезапускается, запрос до него не дошёл. */
const RETRY_MS = [300, 700, 1500, 2500];

/**
 * POST (GET для /auth/config) на path. Ответ прокси «API недоступен» повторяем с паузами (~5 с, крутилка остаётся):
 * повтор безопасен — запрос до сервера не дошёл. Не помогло — 'unavailable'; не JSON с иной ошибкой — 'internal'.
 */
export async function call<T>(path: string, body?: unknown, opts: { fetch?: typeof fetch; delays?: number[] } = {}): Promise<Result<T>> {
  const doFetch = opts.fetch ?? fetch, delays = opts.delays ?? RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const device = opts.fetch ? null : await proofFor(path);   // тесты со своим fetch — без ключа
      const payload = device ? { ...(body as object | undefined), device } : body;
      res = await doFetch(path, {
        method: body === undefined && !device && path.startsWith('/auth/config') ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    } catch {
      return { ok: false, code: 'offline' };
    }
    const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
    if (res.ok) return { ok: true, data: (data ?? {}) as T };
    if (typeof data?.code === 'string') return { ok: false, code: data.code };
    const gateway = res.status === 502 || res.status === 503 || res.status === 504;
    if (gateway && res.status !== 504 && attempt < delays.length) { await new Promise((r) => setTimeout(r, delays[attempt])); continue; }
    return { ok: false, code: gateway ? 'unavailable' : 'internal' };
  }
}

export const ERRORS: Record<string, string> = {
  offline: 'Нет соединения с сервером',
  unavailable: 'Сервер недоступен — попробуйте через минуту',
  flood: 'Слишком много попыток. Попробуйте позже',
  code_invalid: 'Неверный код',
  code_expired: 'Код устарел — запросите новый',
  password_invalid: 'Неверный пароль',
  name_invalid: 'Введите имя',
  recovery_unavailable: 'Почта для восстановления не задана',
  passkey_not_found: 'Этот паскей не привязан к аккаунту',
  passkey_invalid: 'Не удалось войти с паскеем',
  device_invalid: 'Не удалось подтвердить это устройство — обновите страницу и попробуйте снова',
  bad_frame: 'Проверьте введённые данные',
  internal: 'Ошибка на сервере — попробуйте ещё раз',
};
export const errorText = (code: string) => ERRORS[code] ?? ERRORS.internal;

/** Вход завершён: сеанс в cookie. main.tsx слушает и запускает приложение. */
export function signedIn(): void {
  window.dispatchEvent(new CustomEvent('relay:signed-in'));
}
