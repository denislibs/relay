/**
 * Ключ устройства (сеанс, привязанный к устройству; сервер — apps/server/src/deviceAuth.ts).
 * ECDSA P-256, закрытая часть неизвлекаемая и живёт в IndexedDB этого браузера: украденный cookie сеанса без неё
 * не обновит короткий доступ (relay_access, 10 минут) и не откроет сокет. Один и тот же модуль — в движке
 * (SharedWorker), на странице и в Service Worker: у всех один origin, одна база и общие cookie.
 *
 *   refreshAccess  — GET /session/challenge → POST /session/refresh {nonce, sig, key}: первый раз привязывает ключ
 *   deviceFetch    — обёртка fetch: 401 с «x-relay-auth: refresh» → обновить доступ и повторить один раз
 *   signDevice     — подпись «relay-device|<purpose>|<nonce>» (purpose: refresh | ws)
 */
const DB = 'relay-device';
const STORE = 'keys';
const ID = 'device';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Stored { pair: CryptoKeyPair; spki: string }

const b64 = (b: ArrayBuffer): string => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s); };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => { resolve(r.result); db.close(); };
    r.onerror = () => { reject(r.error); db.close(); };
  }));
}

let loading: Promise<Stored> | null = null;
/** Ключ устройства: из базы или новый. Гонка контекстов (страница и воркер создают одновременно) — побеждает записанный первым. */
function deviceKey(): Promise<Stored> {
  return loading ??= (async () => {
    const have = await tx<Stored | undefined>('readonly', (s) => s.get(ID));
    if (have) return have;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const made: Stored = { pair, spki: b64(await crypto.subtle.exportKey('spki', pair.publicKey)) };
    await tx('readwrite', (s) => s.add(made, ID)).catch(() => {});   // уже есть — add откажет, возьмём тот
    return (await tx<Stored | undefined>('readonly', (s) => s.get(ID))) ?? made;
  })().catch((e) => { loading = null; throw e; });
}

export async function signDevice(purpose: 'refresh' | 'ws', nonce: string): Promise<string> {
  const { pair } = await deviceKey();
  return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`relay-device|${purpose}|${nonce}`)));
}

let refreshing: Promise<boolean> | null = null;
/**
 * Обновить короткий доступ (cookie ставит сервер). true — обновлён; false — сервер отказал (сеанса нет или ключ чужой);
 * без сети — исключение. Одновременные вызовы в одном контексте — один запрос.
 */
export function refreshAccess(httpBase = '', f: Fetch = fetch): Promise<boolean> {
  return refreshing ??= (async () => {
    const { spki } = await deviceKey();
    const c = await f(`${httpBase}/session/challenge`, { credentials: 'include' });
    if (!c.ok) return false;
    const { nonce } = await c.json() as { nonce: string };
    const r = await f(`${httpBase}/session/refresh`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, sig: await signDevice('refresh', nonce), key: spki }),
    });
    return r.ok;
  })().finally(() => { refreshing = null; });
}

/** Ответ просит обновить доступ (привязанный сеанс, короткий cookie истёк) — это не «сеанс завершён». */
export const needsRefresh = (r: Response): boolean => r.status === 401 && r.headers.get('x-relay-auth') === 'refresh';

/** fetch с обновлением доступа: 401 «обнови» → refreshAccess → повтор один раз. Отказ в обновлении — исходный 401. */
export function deviceFetch(inner: Fetch, httpBase = ''): Fetch {
  return async (url, init) => {
    const again = typeof Request !== 'undefined' && (url as unknown) instanceof Request ? (url as unknown as Request).clone() : url;   // тело Request читается один раз
    const res = await inner(url, init);
    if (!needsRefresh(res)) return res;
    if (!(await refreshAccess(httpBase, inner))) return res;
    return inner(again as string, init);
  };
}

/** Выход: ключ этого сеанса больше не нужен — следующий вход привяжет новый. */
export async function forgetDeviceKey(): Promise<void> {
  loading = null;
  await tx('readwrite', (s) => s.delete(ID)).catch(() => {});
}
