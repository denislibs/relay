// Привязка завёрнутого ключа к назначению (аудит 2026-10-25, CRYPTO-5). В KMS уходит не голый ключ, а
// «метка ‖ ключ»: chat|<чат>, file|<вложение>, search. Разворачивая, сверяем метку с ожидаемой: ключ файла, который
// клиент сам прислал при загрузке (а значит знает), нельзя подставить вместо ключа чата — даже тому, у кого есть
// запись в базу. Работает поверх любого KMS (поддельный, Vault Transit, сервис ключей): ему это просто байты.
//   формат: 'RKB1' | длина метки (1 байт) | метка (UTF-8) | ключ
// Старые блобы (до привязки) — голые 32 байта: читаются, пока задача crypto.bind не перезавернёт их с меткой.
import { CryptoError } from './aead';
import { kmsFor, type Kms } from './kms';

const MAGIC = new Uint8Array([0x52, 0x4b, 0x42, 0x31]);   // RKB1
const enc = new TextEncoder(), dec = new TextDecoder();

export const chatCtx = (chatId: number) => `chat|${chatId}`;
export const fileCtx = (attachmentId: string) => `file|${attachmentId}`;
export const SEARCH_CTX = 'search';

export function bindKey(ctx: string, dek: Uint8Array): Uint8Array {
  const tag = enc.encode(ctx);
  if (tag.length > 255) throw new Error('key context too long');
  const out = new Uint8Array(MAGIC.length + 1 + tag.length + dek.length);
  out.set(MAGIC, 0); out[MAGIC.length] = tag.length; out.set(tag, MAGIC.length + 1); out.set(dek, MAGIC.length + 1 + tag.length);
  return out;
}

/** Ключ из развёрнутого: метка обязана совпасть. legacy — голые 32 байта старого формата (true — нужно перезавернуть). */
export function unbindKey(ctx: string, plain: Uint8Array): { dek: Uint8Array; legacy: boolean } {
  if (plain.length > MAGIC.length && MAGIC.every((b, i) => plain[i] === b)) {
    const n = plain[MAGIC.length];
    const got = dec.decode(plain.subarray(MAGIC.length + 1, MAGIC.length + 1 + n));
    if (got !== ctx) throw new CryptoError('no_key', `key is bound to «${got}», not «${ctx}»`);
    return { dek: plain.slice(MAGIC.length + 1 + n), legacy: false };
  }
  if (plain.length === 32) return { dek: plain, legacy: true };
  throw new CryptoError('no_key', 'unknown key format');
}

export const wrapFor = (kms: Kms, ctx: string, dek: Uint8Array): Promise<Uint8Array> => kms.wrap(bindKey(ctx, dek));
export async function unwrapFor(ctx: string, wrapped: Uint8Array, kekId: string | null | undefined): Promise<Uint8Array> {
  return unbindKey(ctx, await kmsFor(kekId).unwrap(new Uint8Array(wrapped), kekId)).dek;
}

/**
 * Задача crypto.bind: ключи старого формата (bound = false) — развернуть и завернуть заново с меткой. Пачками; true —
 * всё привязано. Сами ключи не меняются, данные не перешифровываются.
 */
export async function bindLegacyKeys(sql: import('postgres').Sql<{ bigint: number }>, batch = 200): Promise<boolean> {
  const { getKms } = await import('./kms');
  const kms = getKms();
  await kms.init?.();
  const redo = async (ctx: string, wrapped: Uint8Array, kekId: string) => {
    const { dek, legacy } = unbindKey(ctx, await kmsFor(kekId).unwrap(new Uint8Array(wrapped), kekId));
    return legacy ? Buffer.from(await wrapFor(kms, ctx, dek)) : null;
  };
  const chats = await sql`select chat_id, version, wrapped_dek, kek_id from keys.chat_keys where not bound limit ${batch}`;
  for (const r of chats) {
    const next = await redo(chatCtx(Number(r.chat_id)), r.wrapped_dek as Uint8Array, r.kek_id as string);
    await sql`update keys.chat_keys set ${next ? sql`wrapped_dek = ${next}, kek_id = ${kms.id},` : sql``} bound = true
               where chat_id = ${r.chat_id} and version = ${r.version} and wrapped_dek = ${Buffer.from(r.wrapped_dek as Uint8Array)}`;
  }
  const files = await sql`select attachment_id, wrapped, kek_id from keys.attachment_keys where not bound limit ${batch}`;
  for (const r of files) {
    const next = await redo(fileCtx(String(r.attachment_id)), r.wrapped as Uint8Array, r.kek_id as string);
    await sql`update keys.attachment_keys set ${next ? sql`wrapped = ${next}, kek_id = ${kms.id},` : sql``} bound = true
               where attachment_id = ${r.attachment_id} and wrapped = ${Buffer.from(r.wrapped as Uint8Array)}`;
  }
  const [s] = await sql`select wrapped, kek_id from keys.search_key where id = 1 and not bound`;
  if (s) {
    const next = await redo(SEARCH_CTX, s.wrapped as Uint8Array, s.kek_id as string);
    await sql`update keys.search_key set ${next ? sql`wrapped = ${next}, kek_id = ${kms.id},` : sql``} bound = true where id = 1`;
  }
  return chats.length < batch && files.length < batch;
}
