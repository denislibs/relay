/**
 * SRP-6a для облачного пароля: сервер хранит только верификатор v = gˣ, пароль и x на сервер не уходят.
 * Группа — RFC 5054, 2048 бит, g = 2; H — SHA-256; x — PBKDF2-SHA512 (100 000 итераций) от пароля и соли.
 * Математика общая для браузера и сервера (WebCrypto + BigInt).
 */

export const N = BigInt('0x' +
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D' +
  'CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74' +
  '7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D' +
  '5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6' +
  '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73');
export const g = 2n;
const LEN = 256;   // байт в N
export const PBKDF2_ITERATIONS = 100_000;

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n, b = ((base % mod) + mod) % mod, e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

export const toHex = (n: bigint) => n.toString(16);
export const fromHex = (s: string) => BigInt('0x' + (s || '0'));

/** Число → ровно LEN байт big-endian (pad из RFC 5054). */
export function pad(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(LEN * 2, '0');
  const out = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const bytesToBig = (b: Uint8Array) => { let h = ''; for (const x of b) h += x.toString(16).padStart(2, '0'); return BigInt('0x' + (h || '0')); };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

export async function H(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', cat(...parts)));
}

export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function randomBig(bytes = 32): bigint {
  return bytesToBig(crypto.getRandomValues(new Uint8Array(bytes)));
}

let kCache: bigint | null = null;
export async function k(): Promise<bigint> { return kCache ??= bytesToBig(await H(pad(N), pad(g))); }

/** x = PBKDF2-SHA512(пароль, соль) mod N — дорогой шаг: перебор паролей по утёкшему v становится медленным. */
export async function passwordX(password: string, salt: Uint8Array): Promise<bigint> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: PBKDF2_ITERATIONS }, key, 512));
  return bytesToBig(bits) % N;
}

/** Установка пароля (клиент): соль и верификатор для сервера. */
export async function makeVerifier(password: string): Promise<{ salt: string; verifier: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const x = await passwordX(password, salt);
  return { salt: b64u(salt), verifier: toHex(modPow(g, x, N)) };
}

/** Доказательство знания пароля (клиент) по вызову сервера: A и M1. */
export async function clientProof(password: string, salt: string, Bhex: string): Promise<{ A: string; M1: string }> {
  const B = fromHex(Bhex);
  if (B % N === 0n) throw new Error('srp: bad B');
  const x = await passwordX(password, fromB64u(salt));
  let a = 0n, A = 0n;
  do { a = randomBig(32); A = modPow(g, a, N); } while (A % N === 0n);
  const u = bytesToBig(await H(pad(A), pad(B)));
  if (u === 0n) throw new Error('srp: u = 0');
  const kv = (await k()) * modPow(g, x, N);
  const S = modPow(((B - kv) % N + N) % N, a + u * x, N);
  const M1 = await H(pad(A), pad(B), pad(S));
  return { A: toHex(A), M1: b64u(M1) };
}

/** Сервер: вызов по верификатору — секрет b и открытое B. */
export async function serverChallenge(verifierHex: string): Promise<{ b: string; B: string }> {
  const v = fromHex(verifierHex);
  let b = 0n, B = 0n;
  do { b = randomBig(32); B = ((await k()) * v + modPow(g, b, N)) % N; } while (B === 0n);
  return { b: toHex(b), B: toHex(B) };
}

/** Сервер: проверка M1. Сравнение за постоянное время. */
export async function serverVerify(verifierHex: string, bHex: string, Bhex: string, Ahex: string, M1: string): Promise<boolean> {
  const A = fromHex(Ahex), B = fromHex(Bhex), v = fromHex(verifierHex), b = fromHex(bHex);
  if (A <= 0n || A >= N || A % N === 0n) return false;
  const u = bytesToBig(await H(pad(A), pad(B)));
  if (u === 0n) return false;
  const S = modPow(A * modPow(v, u, N), b, N);
  const want = await H(pad(A), pad(B), pad(S));
  let got: Uint8Array;
  try { got = fromB64u(M1); } catch { return false; }
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  return diff === 0;
}
