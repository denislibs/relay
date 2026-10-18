import { hideSpoilers, NO_PREVIEW } from '@relay/protocol';
import { sql } from '../db';
import { nameForSql } from './profile';
import { isOnline } from './presence';
import { DEFAULT_TTL_DAYS } from './sessions';
import { notifyDefaults } from './settings';

/**
 * Web Push без зависимостей: VAPID (RFC 8292) и шифрование aes128gcm (RFC 8291) на WebCrypto.
 * Шлём только тем, у кого нет живого соединения: открытая вкладка уведомит сама.
 */

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

type Vapid = { publicKey: string; key: CryptoKey };
let vapid: Promise<Vapid> | null = null;

/** Ключи VAPID: создаются один раз и живут в server_meta — подписки браузеров привязаны к публичному ключу. */
export function vapidKeys(): Promise<Vapid> {
  return vapid ??= (async () => {
    let [row] = await sql`select v from server_meta where k = 'vapid'`;
    if (!row) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
      await sql`insert into server_meta (k, v) values ('vapid', ${jwk}) on conflict (k) do nothing`;
      [row] = await sql`select v from server_meta where k = 'vapid'`;
    }
    const jwk = JSON.parse(row.v as string) as JsonWebKey;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const publicKey = b64u(cat(new Uint8Array([4]), fromB64u(jwk.x!), fromB64u(jwk.y!)));
    return { publicKey, key };
  })().catch((e) => { vapid = null; throw e; });
}

async function vapidHeader(endpoint: string): Promise<string> {
  const { publicKey, key } = await vapidKeys();
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT ?? 'mailto:relay@localhost' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

/** Тело запроса aes128gcm: заголовок (salt, rs, наш эфемерный ключ) + одна запись. */
export async function encryptPayload(p256dh: string, auth: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64u(p256dh);
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, eph.privateKey, 256));
  const ikm = await hkdf(fromB64u(auth), shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, record);
}

export interface SubscriptionInput {
  endpoint: string; keys: { p256dh: string; auth: string };
  muted?: number[]; hideText?: boolean;
  /** pushsubscriptionchange: прежний endpoint этого браузера — настройки переезжают с него */
  oldEndpoint?: string;
}

/** Подписка этого браузера; sessionId — сеанс, из которого подписались (его конец удаляет подписку). */
export async function subscribe(userId: number, s: SubscriptionInput, sessionId: number): Promise<void> {
  const url = new URL(s.endpoint);   // бросит на мусоре
  if (url.protocol !== 'https:' && process.env.DEV_LOGIN !== '1') throw new Error('endpoint');
  // не прислали muted / hideText (переподписка из SW) — берём из прежней строки этого пользователя
  const prev = s.muted === undefined || typeof s.hideText !== 'boolean'
    ? (await sql`select muted, hide_text from push_subscriptions
                  where user_id = ${userId} and endpoint = any(${[s.endpoint, s.oldEndpoint].filter((e): e is string => typeof e === 'string')})
                  order by (endpoint = ${s.endpoint}) desc limit 1`)[0]
    : undefined;
  const muted = (Array.isArray(s.muted) ? s.muted : (prev?.muted as number[] | undefined) ?? []).filter((n) => Number.isInteger(n)).slice(0, 10000);
  const hideText = typeof s.hideText === 'boolean' ? s.hideText : prev?.hide_text === true;
  await sql.begin(async (tx) => {
    if (typeof s.oldEndpoint === 'string' && s.oldEndpoint !== s.endpoint) await tx`delete from push_subscriptions where endpoint = ${s.oldEndpoint} and user_id = ${userId}`;
    await tx`
      insert into push_subscriptions (endpoint, user_id, p256dh, auth, muted, hide_text, session_id)
      values (${s.endpoint}, ${userId}, ${s.keys.p256dh}, ${s.keys.auth}, ${muted}, ${hideText}, ${sessionId})
      on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        muted = excluded.muted, hide_text = excluded.hide_text, session_id = excluded.session_id`;
  });
}

export async function unsubscribe(userId: number, endpoint: string): Promise<void> {
  await sql`delete from push_subscriptions where endpoint = ${endpoint} and user_id = ${userId}`;
}

// ---- отправка в фоне: ack не ждёт push-сервис; тесты дожидаются хвоста (settlePushes) перед очисткой базы ----
const pending = new Set<Promise<void>>();
export function pushInBackground(m: Parameters<typeof pushNewMessage>[0]): void {
  const p = pushNewMessage(m).catch((e) => console.warn('push', String(e))).finally(() => pending.delete(p));
  pending.add(p);
}
/** Дождаться всех отправок в фоне (в т.ч. начатых, пока ждём). */
export async function settlePushes(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** system — служебное сообщение Relay: SW ставит знак Relay иконкой. */
export type PushPayload = { chatId: number; id: number; title: string; body: string; system?: true };

/** Новое сообщение → push участникам без соединения, кроме отправителя и тех, у кого чат заглушён.
 *  Только подпискам живых сеансов: истёкший или неактивный дольше срока, но ещё не убранный sweepInactive — молчит. */
export async function pushNewMessage(m: { chatId: number; id: number; senderId: number; body: string; entities?: { type: string; offset: number; length: number }[]; kind?: string; attachment?: { name?: string } | null; service?: { type: string } }): Promise<void> {
  m = { ...m, body: hideSpoilers(m.body, m.entities) };   // скрытый текст в уведомление не уходит
  // код входа не уходит в push-сервис и на экран блокировки
  if (m.service?.type === 'login_code') m = { ...m, body: 'Код для входа в Relay' };
  // имя отправителя — глазами получателя (контактное, если он его задал)
  const subs = await sql`
    select s.endpoint, s.user_id, s.p256dh, s.auth, s.hide_text,
           (select ${nameForSql(sql`s.user_id`)} from users u where u.id = ${m.senderId}) as sender_name
      from push_subscriptions s
    join chat_members cm on cm.user_id = s.user_id and cm.chat_id = ${m.chatId}
    join sessions se on se.id = s.session_id
    left join user_settings us on us.user_id = s.user_id
    where s.user_id <> ${m.senderId} and not (${m.chatId} = any(s.muted))
      and se.expires_at > now()
      and se.last_active_at > now() - make_interval(days => coalesce(us.sessions_ttl_days, ${DEFAULT_TTL_DAYS}))
      and not exists (select 1 from blocks b where b.owner_id = s.user_id and b.user_id = ${m.senderId})   -- от заблокированного — никогда`;
  const offline = subs.filter((s) => !isOnline(s.user_id as number));
  if (!offline.length) return;
  const [info] = await sql`select kind, title from chats where id = ${m.chatId}`;
  // умолчания получателя для этого вида чата: выключено — не шлём; без предпросмотра — текст не отдаём
  const defaults = await notifyDefaults(sql, [...new Set(offline.map((s) => s.user_id as number))]);
  const kind = info.kind === 'group' ? 'group' : 'direct';
  const prefOf = (userId: number) => defaults.get(userId)?.[kind] ?? { muted: false, preview: true };
  const targets = offline.filter((s) => !prefOf(s.user_id as number).muted);
  if (!targets.length) return;
  const preview = m.kind === 'voice' ? '🎤 Голосовое сообщение' : m.kind === 'round' ? 'Видеосообщение' : m.kind === 'photo' ? (m.body ? '🖼 ' + m.body : 'Фотография') : m.kind === 'file' ? '📎 ' + (m.body || m.attachment?.name || 'Файл') : m.body;
  await Promise.all(targets.map(async (s) => {
    const name = s.sender_name as string;
    const shown = prefOf(s.user_id as number).preview;
    // «Скрывать текст в уведомлениях» на этом устройстве — ни имени, ни текста (как и локальное уведомление)
    const payload: PushPayload = s.hide_text === true
      ? { chatId: m.chatId, id: m.id, title: 'Relay', body: NO_PREVIEW }
      : kind === 'group'
      ? { chatId: m.chatId, id: m.id, title: (info.title as string) ?? 'Группа', body: shown ? `${name}: ${preview}` : NO_PREVIEW }
      : { chatId: m.chatId, id: m.id, title: name, body: shown ? preview : NO_PREVIEW };
    if (m.service) payload.system = true;
    const plain = enc.encode(JSON.stringify(payload).slice(0, 3000));
    try {
      const res = await fetch(s.endpoint as string, {
        method: 'POST',
        headers: { authorization: await vapidHeader(s.endpoint as string), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
        body: await encryptPayload(s.p256dh as string, s.auth as string, plain),
      });
      // подписка отозвана браузером — забываем
      if (res.status === 404 || res.status === 410) await sql`delete from push_subscriptions where endpoint = ${s.endpoint}`;
    } catch (e) { console.warn('push failed', String(e)); }
  }));
}
