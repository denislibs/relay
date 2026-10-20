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
}

const WRAP_AAD = 'relay|chat-key';
// только dev и тесты: стабилен между процессами (multiprocess-тесты, перезапуск dev-сервера)
const DEV_KEY = 'cmVsYXktZGV2LW1hc3Rlci1rZXktbm90LWZvci1wcm9k';   // «relay-dev-master-key-not-for-prod»

export class FakeKms implements Kms {
  readonly id: string;
  private key: Promise<CryptoKey>;
  constructor(base64 = process.env.RELAY_MASTER_KEY ?? DEV_KEY, id = 'fake:v1') {
    const raw = new Uint8Array(Buffer.from(base64, 'base64'));
    if (raw.length < 32) throw new Error('RELAY_MASTER_KEY must be at least 32 bytes (base64)');
    this.id = id;
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
export function setKms(k: Kms | null): void { kms = k; }
