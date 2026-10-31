// Ключ доступа к человеку (как access_hash в Telegram): чужой id сам по себе ничего не открывает.
//   - peerKey(viewer, target) = HMAC(секрет, «peer:v1|viewer|target»), 12 байт base64url — у каждого зрителя свой;
//   - выдаётся там, где зритель видит человека законно (PublicUser, собеседник в списке чатов, поиск людей, участники);
//   - маршруты, которые обращаются к человеку по id (личный чат, группа, добавить в группу, контакт, блок,
//     карточка контакта, исключения приватности), требуют ключ. Неверный ключ — тот же not_found, что и нет человека:
//     иначе снова оракул перебора.
// Хранить ключи не нужно. Секрет — один на систему, в server_meta; смена секрета отзывает все ключи
// (клиент на not_found дозапрашивает ключ через GET /users?ids= и повторяет).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from '../db';

const KEY_BYTES = 12;
let secret: Buffer | null = null;
let loading: Promise<void> | null = null;

/** Загрузить секрет (создать при первом запуске). Ждут точки входа: сервер, воркер, тесты, сид. */
export function initPeerKeys(): Promise<void> {
  return loading ??= (async () => {
    await sql`insert into server_meta (k, v) values ('peer_key_secret', ${randomBytes(32).toString('base64')}) on conflict (k) do nothing`;
    const [r] = await sql`select v from server_meta where k = 'peer_key_secret'`;
    secret = Buffer.from(r.v as string, 'base64');
  })().catch((e) => { loading = null; throw e; });
}

function mac(viewer: number, target: number): Buffer {
  if (!secret) throw new Error('peer keys are not initialised: await initPeerKeys() at startup');
  return createHmac('sha256', secret).update(`peer:v1|${viewer}|${target}`).digest().subarray(0, KEY_BYTES);
}

/** Ключ зрителя viewer к человеку target. */
export function peerKey(viewer: number, target: number): string {
  return mac(viewer, target).toString('base64url');
}

/** Подходит ли ключ. Себе ключ не нужен. */
export function peerKeyOk(viewer: number, target: number, key: unknown): boolean {
  if (viewer === target) return true;
  if (typeof key !== 'string' || key.length !== 16 || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const got = Buffer.from(key, 'base64url');
  const want = mac(viewer, target);
  return got.length === want.length && timingSafeEqual(got, want);
}
