import { resetChatKeyCache } from '../src/crypto/chatKeys';
import { sql } from '../src/db';
import { processAlive } from '../src/domain/liveRegistry';
import { flushOwn } from '../src/valkey';

export async function resetDb(): Promise<void> {
  resetChatKeyCache();   // номера чатов после truncate начинаются заново — старые ключи в памяти не к ним
  await flushOwn();   // онлайн и прочее эфемерное прошлых тестов
  await processAlive();   // ключ «процесс жив» стёрт вместе с остальным — серверы этого процесса снова в сумме онлайна
  await sql`truncate login_attempts, login_pending, srp_challenges, qr_logins, webauthn_challenges, sessions, chats, chat_members, messages, user_seq, updates,
                     jobs, jobs_dead, dev_mail, link_previews restart identity cascade`;
  await sql`delete from attachments`;   // и картинки превью ссылок — они у системного пользователя, его строку не стираем
  // системного пользователя «Relay» (миграция 110_service) не трогаем
  await sql`delete from users where not system`;
  // поиск — по Postgres, пока тест сам не построит индекс (meili.test.ts)
  await sql`delete from server_meta where k in ('search_index', 'search_building', 'search_reindex_after')`;
  // engine-тесты делают truncate users на общей базе и стирают строку миграции 110_service — вернуть, если пропала
  await sql`insert into users (name, system) select 'Relay', true where not exists (select 1 from users where system)`;
}

export async function makeUser(name = 'user'): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name}) returning id`;
  return row.id as number;
}

import { createChat } from '../src/domain/chats';

export function makeChat(memberIds: number[], kind: 'direct' | 'group' = memberIds.length > 2 ? 'group' : 'direct'): Promise<number> {
  return createChat(kind, kind === 'group' ? 'Группа' : null, memberIds);
}

import type { ServerFrame } from '@relay/protocol';

/** Ждёт первый кадр, удовлетворяющий условию. */
export function nextFrame(ws: WebSocket, match: (f: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error('timeout waiting for frame')); }, timeoutMs);
    function on(e: MessageEvent) {
      const f = JSON.parse(String(e.data)) as ServerFrame;
      if (match(f)) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(f); }
    }
    ws.addEventListener('message', on);
  });
}

// ---- «браузер» для Web Push: ключи подписки и расшифровка по RFC 8291 ----
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}
export async function pushBrowser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: b64u(pub), auth: b64u(auth) },
    async decrypt(body: Uint8Array) {
      const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
      const as = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
      const ikm = await hkdf(auth, shared, cat(enc.encode('WebPush: info\0'), pub, asPub), 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, rec));
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

// ---- вложения: подписанный PUT прямо в S3 и подтверждение ----
export type UploadMetaInput = { name: string; mime: string; size?: number; w?: number; h?: number; kind?: string; duration?: number; waveform?: string };

/** Шаг 1 (выдача ссылки) — ответ как есть. */
export const uploadIntent = (base: string, token: string, meta: UploadMetaInput) =>
  fetch(`${base}/uploads`, { method: 'POST', headers: { cookie: `relay_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(meta) });

/** Полный путь клиента: ссылка → PUT в хранилище с выданным типом → подтверждение. Возвращает ответ подтверждения (вложение). */
export async function uploadFile(base: string, token: string, meta: Omit<UploadMetaInput, 'size'>, body: Uint8Array | string): Promise<Record<string, unknown>> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const res = await uploadIntent(base, token, { ...meta, size: bytes.length });
  if (!res.ok) throw new Error(`intent ${res.status} ${await res.text()}`);
  const { id, url, mime } = (await res.json()) as { id: string; url: string; mime: string };
  const put = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-type': mime } });
  if (!put.ok) throw new Error(`put ${put.status}`);
  const ok = await fetch(`${base}/uploads/${id}/confirm`, { method: 'POST', headers: { cookie: `relay_session=${token}` } });
  if (!ok.ok) throw new Error(`confirm ${ok.status} ${await ok.text()}`);
  return (await ok.json()) as Record<string, unknown>;
}

import type { Update } from '@relay/protocol';
import { getUpdates } from '../src/domain/journal';

/** События журнала пользователя в том виде, в каком их получает клиент (sync): журнал хранит ссылки, тела подставляются при чтении. */
export async function journalOf(userId: number, type?: Update['type']): Promise<Update[]> {
  const { items } = await getUpdates(userId, 0, 100_000);
  return items.map((i) => i.update).filter((u) => !type || u.type === type);
}

import { openRows } from '../src/domain/messageContent';
/** Строки messages, как их видит сервер: содержимое — из шифра (для проверок текста в тестах). */
export const opened = <T extends Record<string, unknown>>(rows: T[]): Promise<T[]> => openRows(rows);
