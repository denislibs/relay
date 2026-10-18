import { createHash, randomInt } from 'node:crypto';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { postService, pushService, systemUserId } from './service';
import type { Message } from '@relay/protocol';

export const CODE_LENGTH = 5;
const CODE_TTL_MIN = 5, MAX_TRIES = 5, MAX_PER_HOUR = 5;
const hash = (code: string) => createHash('sha256').update('relay-login:' + code).digest('hex');

/** Вход по телефону («+7…») или имени пользователя («@anna» / «anna»). Системного пользователя не найти. */
async function findUser(login: string): Promise<number | null> {
  const s = login.trim();
  const [r] = s.startsWith('+')
    ? await sql`select id from users where phone = ${s} and not system`
    : await sql`select id from users where lower(username) = ${s.replace(/^@/, '').toLowerCase()} and not system`;
  return r ? Number(r.id) : null;
}

/** Текст сообщения с кодом; entity code — моноширинный, клиент копирует его по клику. */
export function codeMessage(code: string): { body: string; entities: { type: 'code'; offset: number; length: number }[] } {
  const head = 'Код для входа в Relay: ';
  const body = `${head}${code}\n\nНикому не сообщайте этот код, даже если его просят от имени Relay. Он нужен только для входа в ваш аккаунт.\n\nЕсли вы не входили, ничего не делайте — без кода войти нельзя.`;
  return { body, entities: [{ type: 'code', offset: head.length, length: code.length }] };
}

/**
 * Попытка входа: код уходит в служебный чат на устройства, где аккаунт уже открыт.
 * Неизвестный логин отвечает так же: попытка записывается на системного пользователя со случайным хэшем,
 * её код не совпадёт никогда — по ответам нельзя понять, есть ли такой аккаунт.
 * via 'none' — открытых сеансов нет, код доставить некуда (SMS в Relay нет).
 */
export async function requestCode(login: string): Promise<{ attemptId: string; via: 'app' | 'none'; length: 5; devCode?: string }> {
  const attemptId = crypto.randomUUID();
  const expires = sql`now() + ${CODE_TTL_MIN + ' minutes'}::interval`;
  const userId = await findUser(login);
  if (userId == null) {
    await sql`insert into login_attempts (id, user_id, code_hash, expires_at) values (${attemptId}, ${await systemUserId()}, ${hash(crypto.randomUUID())}, ${expires})`;
    return { attemptId, via: 'app', length: CODE_LENGTH };
  }
  const [{ n }] = await sql`select count(*)::int as n from login_attempts where user_id = ${userId} and created_at > now() - interval '1 hour'`;
  if (n >= MAX_PER_HOUR) throw new DomainError('flood');
  const [{ live }] = await sql`select count(*)::int as live from sessions where user_id = ${userId} and expires_at > now()`;
  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  let posted: Message | null = null;
  await sql.begin(async (tx) => {
    await tx`insert into login_attempts (id, user_id, code_hash, expires_at) values (${attemptId}, ${userId}, ${hash(code)}, ${expires})`;
    if (live) posted = await postService(tx, userId, { type: 'login_code', ...codeMessage(code) });
  });
  if (posted) pushService(posted);   // push только после коммита
  return { attemptId, via: live ? 'app' : 'none', length: CODE_LENGTH, ...(process.env.DEV_LOGIN === '1' ? { devCode: code } : {}) };
}

/**
 * Проверка кода. Попытки нет (использована, сожжена, истекла, кончились попытки) — code_expired.
 * Неверный код — code_invalid; пятая ошибка удаляет попытку. Верный — попытка удаляется (код одноразовый).
 */
export async function signIn(attemptId: string, code: string): Promise<{ userId: number }> {
  if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw new DomainError('code_invalid');
  const sys = await systemUserId();
  // исход возвращаем из транзакции, а бросаем после коммита: throw внутри sql.begin откатил бы счётчик попыток и удаление
  const outcome = await sql.begin(async (tx): Promise<{ userId: number } | 'code_invalid' | 'code_expired'> => {
    const [a] = await tx`select user_id, code_hash, tries, expires_at < now() as expired from login_attempts where id = ${attemptId} for update`;
    if (!a) return 'code_expired';
    if (a.expired) { await tx`delete from login_attempts where id = ${attemptId}`; return 'code_expired'; }
    if (a.code_hash !== hash(code.trim()) || Number(a.user_id) === sys) {
      if (a.tries + 1 >= MAX_TRIES) await tx`delete from login_attempts where id = ${attemptId}`;
      else await tx`update login_attempts set tries = tries + 1 where id = ${attemptId}`;
      return 'code_invalid';
    }
    await tx`delete from login_attempts where id = ${attemptId}`;
    return { userId: Number(a.user_id) };
  });
  if (typeof outcome === 'string') throw new DomainError(outcome);
  return outcome;
}

/** Код появился в исходящем тексте — сжигаем все такие попытки владельца (защита от «пришлите код из Relay»). */
export async function burnCodes(tx: Tx, userId: number, text: string): Promise<void> {
  const codes = [...new Set(text.replace(/-/g, '').match(/\d{5}/g) ?? [])];
  if (!codes.length) return;
  await tx`delete from login_attempts where user_id = ${userId} and code_hash = any(${codes.map(hash)})`;
}
