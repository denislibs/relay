// Главный ключ (KEK) живёт вне базы: в KMS. Сервер просит его завернуть или развернуть ключ чата (DEK) —
// сам главный ключ серверу не виден. Реализации:
//   fake  — главный ключ из env RELAY_MASTER_KEY (base64, 32 байта): dev и тесты; в production запрещён;
//   vault — HashiCorp Vault / OpenBao, движок Transit: VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_KEY.
import { CryptoError, importAesKey, openBytes, seal } from './aead';

export interface Kms {
  /** Идентификатор главного ключа (пишется рядом с завёрнутым ключом чата). */
  readonly id: string;
  wrap(dek: Uint8Array): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>;
  /** Завёрнуто не последней версией главного ключа (Vault: ключ повернули) — пора перезавернуть. */
  stale?(wrapped: Uint8Array): Promise<boolean>;
  /** Перезавернуть последней версией, не раскрывая ключ чата (Vault Transit rewrap). */
  rewrap?(wrapped: Uint8Array): Promise<Uint8Array>;
}

const WRAP_AAD = 'relay|chat-key';
// только dev и тесты: стабилен между процессами (multiprocess-тесты, перезапуск dev-сервера)
const DEV_KEY = 'cmVsYXktZGV2LW1hc3Rlci1rZXktbm90LWZvci1wcm9k';   // «relay-dev-master-key-not-for-prod»

export class FakeKms implements Kms {
  readonly id: string;
  private key: Promise<CryptoKey>;
  constructor(base64 = process.env.RELAY_MASTER_KEY ?? DEV_KEY) {
    const raw = new Uint8Array(Buffer.from(base64, 'base64'));
    if (raw.length < 32) throw new Error('RELAY_MASTER_KEY must be at least 32 bytes (base64)');
    // id — отпечаток ключа: сменили RELAY_MASTER_KEY — у новых записей другой id, старые перезаворачивает crypto.rewrap
    this.id = 'fake:' + new Bun.CryptoHasher('sha256').update(raw.subarray(0, 32)).digest('hex').slice(0, 12);
    this.key = importAesKey(raw.subarray(0, 32));
  }
  async wrap(dek: Uint8Array) { return seal(await this.key, 0, dek, WRAP_AAD); }
  async unwrap(wrapped: Uint8Array) { return openBytes(await this.key, wrapped, WRAP_AAD); }
}

/** Vault/OpenBao Transit: главный ключ не покидает Vault; наружу — только шифр «vault:vN:…». */
export class VaultKms implements Kms {
  readonly id: string;
  constructor(private addr = process.env.VAULT_ADDR!, private token = process.env.VAULT_TOKEN!, private keyName = process.env.VAULT_TRANSIT_KEY ?? 'relay-chat-keys') {
    if (!addr || !token) throw new Error('VAULT_ADDR and VAULT_TOKEN are required for KMS_PROVIDER=vault');
    this.id = 'vault:transit/' + keyName;
  }
  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    const res = await fetch(`${this.addr}/v1/transit/${op}/${this.keyName}`, {
      method: 'POST', headers: { 'x-vault-token': this.token, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new CryptoError('no_key', `KMS ${op} failed: ${res.status}`);
    return ((await res.json()) as { data: Record<string, string> }).data;
  }
  async wrap(dek: Uint8Array) {
    const { ciphertext } = await this.call('encrypt', { plaintext: Buffer.from(dek).toString('base64') });
    return new TextEncoder().encode(ciphertext);
  }
  async unwrap(wrapped: Uint8Array) {
    const { plaintext } = await this.call('decrypt', { ciphertext: new TextDecoder().decode(wrapped) });
    return new Uint8Array(Buffer.from(plaintext, 'base64'));
  }
  private latest: { v: number; at: number } | null = null;
  async stale(wrapped: Uint8Array) {
    if (!this.latest || Date.now() - this.latest.at > 60_000) {
      const res = await fetch(`${this.addr}/v1/transit/keys/${this.keyName}`, { headers: { 'x-vault-token': this.token } });
      if (!res.ok) throw new CryptoError('no_key', `KMS key info failed: ${res.status}`);
      this.latest = { v: ((await res.json()) as { data: { latest_version: number } }).data.latest_version, at: Date.now() };
    }
    const v = Number(/^vault:v(\d+):/.exec(new TextDecoder().decode(wrapped))?.[1] ?? 0);
    return v < this.latest.v;
  }
  async rewrap(wrapped: Uint8Array) {
    const res = await fetch(`${this.addr}/v1/transit/rewrap/${this.keyName}`, {
      method: 'POST', headers: { 'x-vault-token': this.token, 'content-type': 'application/json' }, body: JSON.stringify({ ciphertext: new TextDecoder().decode(wrapped) }),
    });
    if (!res.ok) throw new CryptoError('no_key', `KMS rewrap failed: ${res.status}`);
    return new TextEncoder().encode(((await res.json()) as { data: { ciphertext: string } }).data.ciphertext);
  }
}

let kms: Kms | null = null;
export function getKms(): Kms {
  if (kms) return kms;
  const provider = process.env.KMS_PROVIDER ?? 'fake';
  if (provider === 'vault') return (kms = new VaultKms());
  if (process.env.NODE_ENV === 'production' && !process.env.RELAY_ALLOW_FAKE_KMS) throw new Error('KMS_PROVIDER=fake is not allowed in production');
  return (kms = new FakeKms());
}
/** Тесты: подменить KMS (например, «недоступен»). */
export function setKms(k: Kms | null): void { kms = k; previous = undefined; }

let previous: FakeKms | null | undefined;
/**
 * KMS, которым завёрнут ключ с этим kek_id: текущий, а при смене поддельного главного ключа — прежний
 * (RELAY_MASTER_KEY_PREVIOUS), пока crypto.rewrap не перезавернёт всё новым.
 */
export function kmsFor(kekId?: string | null): Kms {
  const cur = getKms();
  if (!kekId || kekId === cur.id) return cur;
  if (previous === undefined) previous = process.env.RELAY_MASTER_KEY_PREVIOUS ? new FakeKms(process.env.RELAY_MASTER_KEY_PREVIOUS) : null;
  if (previous && previous.id === kekId) return previous;
  return cur;   // vault: один id на все версии ключа — Vault сам знает, какой версией завёрнуто
}

/**
 * Шаг перезаворачивания (задача crypto.rewrap): ключи чатов, завёрнутые не текущим главным ключом (другой kek_id
 * или устаревшая версия ключа Vault), — заново текущим. Сами ключи чатов не меняются, данные не перешифровываются.
 */
export async function rewrapStep(sql: import('postgres').Sql<{ bigint: number }>, after: [number, number] = [0, 0], batch = 200): Promise<{ rewrapped: number; next: [number, number]; done: boolean }> {
  const cur = getKms();
  const rows = await sql`select chat_id, version, wrapped_dek, kek_id from keys.chat_keys
                          where (chat_id, version) > (${after[0]}, ${after[1]}) order by chat_id, version limit ${batch}`;
  let rewrapped = 0;
  for (const r of rows) {
    const wrapped = new Uint8Array(r.wrapped_dek as Uint8Array);
    const sameKek = r.kek_id === cur.id;
    if (sameKek && !(await cur.stale?.(wrapped))) continue;
    const next = sameKek && cur.rewrap ? await cur.rewrap(wrapped) : await cur.wrap(await kmsFor(r.kek_id as string).unwrap(wrapped));
    await sql`update keys.chat_keys set wrapped_dek = ${Buffer.from(next)}, kek_id = ${cur.id}
               where chat_id = ${r.chat_id} and version = ${r.version} and wrapped_dek = ${Buffer.from(wrapped)}`;
    rewrapped++;
  }
  const last = rows.at(-1);
  return { rewrapped, next: last ? [Number(last.chat_id), Number(last.version)] : after, done: rows.length < batch };
}
