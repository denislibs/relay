import { createHash, randomInt } from 'node:crypto';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { postService, systemUserId } from './service';
import { updateContent } from './messageContent';
import { fanOut } from './journal';

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

/** Текст сообщения с кодом: код под спойлером (не прочесть через плечо и в превью), моноширинный — по клику копируется. */
export function codeMessage(code: string): { body: string; entities: { type: 'code' | 'spoiler'; offset: number; length: number }[] } {
  const head = 'Код для входа в Relay: ';
  const body = `${head}${code}\n\nНикому не сообщайте этот код, даже если его просят от имени Relay. Он нужен только для входа в ваш аккаунт.\n\nЕсли вы не входили, ничего не делайте — без кода войти нельзя.`;
  return { body, entities: [{ type: 'code', offset: head.length, length: code.length }, { type: 'spoiler', offset: head.length, length: code.length }] };
}

export const CODE_USED = 'Код использован для входа.';
export const CODE_REPLACED = 'Код заменён новым.';

/**
 * Скрыть цифры в сообщениях с кодами входа владельца (login_attempts.message_id): код уходит из текста, вместо него —
 * «•••••» и итог курсивом. Всем устройствам — правкой (messageMarkup), как итоги под «Новым входом».
 */
export async function hideLoginCodes(tx: Tx, userId: number, note: string): Promise<void> {
  // returning после update отдал бы уже null — прежнее значение берём из подзапроса
  const rows = await tx`
    update login_attempts a set message_id = null
      from (select id, message_id from login_attempts where user_id = ${userId} and message_id is not null for update) old
     where a.id = old.id
    returning old.message_id`;
  if (!rows.length) return;
  const [svc] = await tx`select chat_id from service_chats where user_id = ${userId}`;
  if (!svc) return;
  const chatId = Number(svc.chat_id);
  for (const r of rows) {
    const id = Number(r.message_id);
    const head = 'Код для входа в Relay: ';
    const body = `${head}${'•'.repeat(CODE_LENGTH)}\n\n${note}`;
    const entities = [{ type: 'italic' as const, offset: body.length - note.length, length: note.length }];
    const row = await updateContent(tx, chatId, id, (c, m) => (m.deleted ? false : { body, entities }));
    if (!row) continue;
    await fanOut(tx, [userId], { type: 'messageMarkup', chatId, id, body, entities, buttons: null });
  }
}

/** Нормализованный логин — ключ лимитов: телефон как есть (после trim), имя без «@» и в нижнем регистре. */
const normalize = (login: string) => { const s = login.trim(); return s.startsWith('+') ? s : s.replace(/^@/, '').toLowerCase(); };
const MAX_WRONG_PER_HOUR = 15, MAX_PER_IP_HOUR = 30;
/** burnCodes: серии длиннее — не код, а мусор; окон на сообщение не больше BURN_MAX_WINDOWS (работа ограничена). */
const BURN_MAX_RUN = 64, BURN_MAX_WINDOWS = 256;

/**
 * Попытка входа: код уходит в служебный чат на устройства, где аккаунт уже открыт.
 * Неизвестный логин отвечает так же: попытка записывается на системного пользователя со случайным хэшем,
 * её код не совпадёт никогда — по ответам нельзя понять, есть ли такой аккаунт (лимит тоже по строке логина).
 * via всегда 'app': нет открытых сеансов — отвечаем так же, но код никому не доставляется и хэш неугадываемый
 * (кроме DEV_LOGIN: там реальный хэш и devCode) — иначе ответ выдавал бы, есть ли аккаунт и открыт ли он.
 * Попытки не удаляются при использовании (dead_at) — иначе «запрос → 5 неверных → запрос» обходил бы часовой лимит.
 * Лимит в час — по строке логина (для любого, в т.ч. неизвестного) и, если логин найден, ещё и по аккаунту:
 * телефон и @имя одного человека — разные строки, но коды одного аккаунта.
 * ip — адрес запроса; null (вызов изнутри процесса) — без лимита по адресу.
 */
export async function requestCode(login: string, ip: string | null = null): Promise<{ attemptId: string; via: 'app'; length: 5; devCode?: string }> {
  const attemptId = crypto.randomUUID();
  const key = normalize(login);
  const userId = await findUser(login);
  const sys = await systemUserId();
  const dev = process.env.DEV_LOGIN === '1';
  // запись без привязки к человеку: неавторизованный вызов не должен копить строки бесконечно (час нужен лимитам)
  await sql`delete from login_attempts where created_at < now() - interval '1 day'`;
  let code = '';
  await sql.begin(async (tx) => {
    // замок на логин (и адрес): подсчёт и вставка в одной транзакции, параллельные запросы не обгонят лимит
    await tx`select pg_advisory_xact_lock(hashtext(${'login:' + key}))`;
    if (ip) {
      await tx`select pg_advisory_xact_lock(hashtext(${'ip:' + ip}))`;
      const [{ n }] = await tx`select count(*)::int as n from login_attempts where ip = ${ip} and created_at > now() - interval '1 hour'`;
      if (n >= MAX_PER_IP_HOUR) throw new DomainError('flood');
    }
    const [{ n }] = await tx`select count(*)::int as n from login_attempts where login = ${key} and created_at > now() - interval '1 hour'`;
    if (n >= MAX_PER_HOUR) throw new DomainError('flood');
    if (userId != null) {
      // порядок замков везде один (логин → адрес → аккаунт) — взаимной блокировки нет
      await tx`select pg_advisory_xact_lock(hashtext(${'user:' + userId}))`;
      const [{ n: own }] = await tx`select count(*)::int as n from login_attempts where user_id = ${userId} and created_at > now() - interval '1 hour'`;
      if (own >= MAX_PER_HOUR) throw new DomainError('flood');
    }
    const expires = tx`now() + ${CODE_TTL_MIN + ' minutes'}::interval`;
    if (userId == null) {
      // новый номер: регистрация возможна, только если код есть куда доставить — без SMS это лишь dev (devCode)
      const signup = dev && /^\+[0-9]{7,15}$/.test(key);
      if (signup) code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
      await tx`insert into login_attempts (id, user_id, code_hash, expires_at, login, ip) values (${attemptId}, ${sys}, ${hash(signup ? code : crypto.randomUUID())}, ${expires}, ${key}, ${ip})`;
      return;
    }
    const [{ live }] = await tx`select count(*)::int as live from sessions where user_id = ${userId} and expires_at > now()`;
    code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    // некому получить код — реальный хэш хранится только в dev (devCode), иначе его мог бы лишь угадать злоумышленник
    const stored = live || dev ? hash(code) : hash(crypto.randomUUID());
    await tx`insert into login_attempts (id, user_id, code_hash, expires_at, login, ip) values (${attemptId}, ${userId}, ${stored}, ${expires}, ${key}, ${ip})`;
    if (live) {
      // прежние коды в чате больше не показываем: новая попытка — старые цифры скрыты («Код заменён новым»)
      await hideLoginCodes(tx, userId, CODE_REPLACED);
      const m = await postService(tx, userId, { type: 'login_code', ...codeMessage(code) });
      await tx`update login_attempts set message_id = ${m.id} where id = ${attemptId}`;
    }
  });
  return { attemptId, via: 'app', length: CODE_LENGTH, ...(dev && code ? { devCode: code } : {}) };
}

/**
 * Проверка кода. Попытки нет или она мертва (использована, сожжена, исчерпана, истекла) — code_expired.
 * Неверный код — code_invalid; пятая ошибка убивает попытку. Верный — попытка гасится (код одноразовый).
 * 15 неверных кодов за час по одной цели (аккаунту или строке логина) — flood.
 */
/** signupPhone — код верный, но аккаунта с этим номером нет: дальше регистрация. */
export async function signIn(attemptId: string, code: string): Promise<{ userId: number } | { signupPhone: string }> {
  if (!/^[0-9a-f-]{36}$/.test(attemptId)) throw new DomainError('code_invalid');
  const sys = await systemUserId();
  // исход возвращаем из транзакции, а бросаем после коммита: throw внутри sql.begin откатил бы счётчик попыток
  const outcome = await sql.begin(async (tx): Promise<{ userId: number } | { signupPhone: string } | 'code_invalid' | 'code_expired' | 'flood'> => {
    const [a] = await tx`select user_id, login, code_hash, tries, (expires_at < now()) as expired from login_attempts where id = ${attemptId} and dead_at is null for update`;
    if (!a || a.expired) return 'code_expired';
    const [{ wrong }] = await tx`
      select coalesce(sum(tries), 0)::int as wrong from login_attempts
       where created_at > now() - interval '1 hour' and (login = ${a.login} or (user_id = ${a.user_id} and user_id <> ${sys}))`;
    if (wrong >= MAX_WRONG_PER_HOUR) return 'flood';
    if (a.code_hash !== hash(code.trim())) {
      await tx`update login_attempts set tries = tries + 1, dead_at = case when tries + 1 >= ${MAX_TRIES} then now() end where id = ${attemptId}`;
      return 'code_invalid';
    }
    await tx`update login_attempts set dead_at = now() where id = ${attemptId}`;
    // код сделал своё — в чате его цифр больше нет (новое устройство не прочтёт старые коды из истории)
    if (Number(a.user_id) !== sys) await hideLoginCodes(tx, Number(a.user_id), CODE_USED);
    // попытка на системного пользователя с верным кодом — только регистрация нового номера (см. requestCode)
    if (Number(a.user_id) === sys) return /^\+[0-9]{7,15}$/.test(a.login as string) ? { signupPhone: a.login as string } : 'code_invalid';
    return { userId: Number(a.user_id) };
  });
  if (typeof outcome === 'string') throw new DomainError(outcome);
  return outcome;
}

/**
 * Код появился в исходящем тексте — гасим все такие попытки владельца (защита от «пришлите код из Relay»).
 * Цифры, разбитые пробелами/точками/дефисами, склеиваем; каждое пятизначное окно в серии цифр — кандидат.
 * Серии длиннее BURN_MAX_RUN цифр пропускаем, кандидатов не больше BURN_MAX_WINDOWS — длинный текст не нагружает сервер.
 */
export async function burnCodes(tx: Tx, userId: number, text: string): Promise<void> {
  const codes = new Set<string>();
  const windows = new Set<string>();
  scan: for (const run of text.match(/\d(?:[\s.\-]*\d)*/g) ?? []) {
    const d = run.replace(/\D/g, '');
    if (d.length > BURN_MAX_RUN) continue;
    for (let i = 0; i + CODE_LENGTH <= d.length; i++) {
      windows.add(d.slice(i, i + CODE_LENGTH));
      if (windows.size >= BURN_MAX_WINDOWS) break scan;
    }
  }
  for (const w of windows) codes.add(hash(w));
  if (!codes.size) return;
  await tx`update login_attempts set dead_at = now() where user_id = ${userId} and dead_at is null and code_hash = any(${[...codes]})`;
}
