import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { clientProof, makeVerifier } from '@relay/protocol/src/srp';

/** Настройки входа: облачный пароль (SRP — пароль не уходит на сервер) и паскеи. Ответ — данные или код ошибки. */

export type PasswordState = { enabled: boolean; hint: string; email: string | null };
export type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
type R<T> = { ok: true; data: T } | { ok: false; code: string };

async function req<T>(method: string, path: string, body?: unknown): Promise<R<T>> {
  try {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data: data as T } : { ok: false, code: (data as { code?: string }).code ?? 'internal' };
  } catch { return { ok: false, code: 'offline' }; }
}

export const getPassword = () => req<PasswordState>('GET', '/settings/password');

/** Доказательство текущего пароля (для смены и снятия). */
async function proofOf(current: string): Promise<R<{ srpId: string; A: string; M1: string }>> {
  const ch = await req<{ srpId: string; salt: string; B: string }>('POST', '/settings/password/challenge', {});
  if (!ch.ok) return ch;
  return { ok: true, data: { srpId: ch.data.srpId, ...(await clientProof(current, ch.data.salt, ch.data.B)) } };
}

export async function savePassword(next: { password: string; hint: string; email: string }, current: string | null): Promise<R<{ enabled: true }>> {
  const v = await makeVerifier(next.password);
  let proof: unknown;
  if (current != null) { const p = await proofOf(current); if (!p.ok) return p; proof = p.data; }
  return req('PUT', '/settings/password', { next: { ...v, hint: next.hint, email: next.email || null }, proof });
}

export async function removePassword(current: string): Promise<R<{ enabled: false }>> {
  const p = await proofOf(current);
  if (!p.ok) return p;
  return req('DELETE', '/settings/password', p.data);
}

export const passkeysSupported = () => browserSupportsWebAuthn();
export const listPasskeys = () => req<{ passkeys: Passkey[]; max: number }>('GET', '/settings/passkeys');
export const deletePasskey = (id: string) => req<{ passkeys: Passkey[]; max: number }>('DELETE', '/settings/passkeys/' + encodeURIComponent(id));

/** Создание: параметры с сервера → окно браузера/менеджера паролей → проверка на сервере. Отмена — code 'cancelled'. */
export async function createPasskey(): Promise<R<{ passkeys: Passkey[]; max: number }>> {
  const o = await req<{ id: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('POST', '/settings/passkeys/options', {});
  if (!o.ok) return o;
  let response: unknown;
  try { response = await startRegistration({ optionsJSON: o.data.options }); } catch { return { ok: false, code: 'cancelled' }; }
  return req('POST', '/settings/passkeys', { id: o.data.id, response });
}

export const qrInfo = (token: string) => req<{ device: string | null; ip: string | null; createdAt: string }>('GET', '/auth/qr/info?token=' + encodeURIComponent(token));
export const acceptQr = (token: string) => req<{ ok: true }>('POST', '/auth/qr/accept', { token });
