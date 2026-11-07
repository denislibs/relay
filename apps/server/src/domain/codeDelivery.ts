import { sql } from '../db';
import { PermanentError } from '../jobs/handlers';
import { enqueue, type Db } from '../jobs/queue';
import { botApi } from './telegramBot';
import { codeChannel, type CodeItem, type CodeKind, type Env } from './codeChannel';

export * from './codeChannel';

/**
 * Доставка одноразовых кодов (вход, регистрация нового номера, восстановление пароля). Канал — CODE_DELIVERY:
 *   dev      — код в ответе (devCode) и в dev_mail (/dev/codes); по умолчанию при DEV_LOGIN=1;
 *   log      — код строкой в лог server/worker; по умолчанию при LOG_LOGIN_CODES=1;
 *   telegram — сообщение бота в один чат владельца (TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID), он передаёт код сам.
 * Не задан и dev-флагов нет — 'none': код получают только устройства, где аккаунт уже открыт (служебный чат).
 * Внешние каналы идут через очередь задач (code.deliver): после коммита, с повторами — сбой Telegram не держит вход.
 * Дальше — smsaero / twilio тем же путём (docs/code-delivery.md).
 */

/** Поставить доставку в транзакции, где код записан: уйдёт после коммита. Код — под secret (в jobs_dead не копируется). */
export async function queueCode(db: Db, item: CodeItem): Promise<void> {
  const { code, ...rest } = item;
  await enqueue(db, 'code.deliver', { ...rest, secret: { code } }, { maxAttempts: 6 });
}

/** Логин или адрес в логе — не целиком: «+79•••••22», «a•••», «m•••@mail.ru». */
export const maskTo = (to: string): string =>
  to.includes('@') && !to.startsWith('@') ? to.replace(/^(.)[^@]*/, '$1•••')
    : to.startsWith('+') ? to.slice(0, 3) + '•'.repeat(Math.max(0, to.length - 5)) + to.slice(-2)
    : to.slice(0, 1) + '•••';

const KIND_TITLE: Record<CodeKind, string> = { login: 'вход', signup: 'регистрация нового номера', recovery: 'восстановление пароля' };

/** Текст сообщения владельцу и сущности: код моноширинный (в Telegram копируется по нажатию). */
export function telegramText(item: CodeItem, env: Env = process.env): { text: string; entities: { type: 'bold' | 'code'; offset: number; length: number }[] } {
  const tz = env.CODE_TIME_ZONE || 'UTC';
  const head = `Relay — ${KIND_TITLE[item.kind]}`;
  const who = `${item.kind === 'recovery' ? 'Почта' : item.to.startsWith('+') ? 'Номер' : 'Логин'}: ${item.to}`;
  const codeAt = `${head}\n${who}\nКод: `.length;
  let text = `${head}\n${who}\nКод: ${item.code}`;
  if (item.expiresAt) {
    const until = new Date(item.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    text += `\nДействует до ${until} (${tz})`;
  }
  return { text, entities: [{ type: 'bold', offset: 0, length: head.length }, { type: 'code', offset: codeAt, length: item.code.length }] };
}

/** sendMessage Bot API — только в TELEGRAM_OWNER_CHAT_ID (или, через deliverExternal, в чат, где номер подтверждён). */
export async function sendTelegram(text: string, entities: unknown[], env: Env = process.env, chatId: string | number | undefined = env.TELEGRAM_OWNER_CHAT_ID): Promise<void> {
  if (!chatId) throw new PermanentError('telegram: TELEGRAM_OWNER_CHAT_ID is required');
  await botApi('sendMessage', { chat_id: chatId, text, entities, link_preview_options: { is_disabled: true } }, env);
}

/** Потолок сообщений бота за сутки (UTC): от перебора номеров и засыпания чата владельца. */
export const telegramDailyCap = (env: Env = process.env): number => Number(env.TELEGRAM_DAILY_CAP) || 300;

/**
 * Доставить код внешним каналом (задачи code.deliver и mail.recovery, воркер). Истёкший код не шлём;
 * сверх дневного потолка — тоже, с предупреждением в логе. В логе — только исход и маска адресата, без кода.
 */
export async function deliverExternal(item: CodeItem, env: Env = process.env): Promise<void> {
  const ch = codeChannel(env);
  if (ch !== 'telegram') throw new PermanentError(`code delivery: channel ${ch} is not external`);
  const label = `code delivery: telegram ${item.kind} for ${maskTo(item.to)}`;
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) { console.warn(`${label}: expired before delivery, dropped`); return; }
  const cap = telegramDailyCap(env);
  // место под потолком — занимаем до отправки одной командой: параллельные воркеры не проскочат его вместе
  const [slot] = await sql`
    insert into code_deliveries (channel, day, n) values ('telegram', (now() at time zone 'utc')::date, 1)
    on conflict (channel, day) do update set n = code_deliveries.n + 1 where code_deliveries.n < ${cap}
    returning n`;
  if (!slot) { console.warn(`${label}: daily cap ${cap} reached, not sent (TELEGRAM_DAILY_CAP)`); return; }
  try {
    // номер подтверждён в боте («Войти через Telegram», telegramLogin.ts) — код самому человеку, иначе владельцу
    if (!(await sendDirect(item, env))) {
      const { text, entities } = telegramText(item, env);
      await sendTelegram(text, entities, env);
    }
  } catch (e) {
    await sql`update code_deliveries set n = n - 1 where channel = 'telegram' and day = (now() at time zone 'utc')::date and n > 0`;
    console.warn(`${label}: failed — ${(e as Error).message}`);
    throw e;
  }
  const sent = Number(slot.n);
  if (sent === 1) await sql`delete from code_deliveries where day < (now() at time zone 'utc')::date - 7`;
  console.log(`${label}: sent${direct.has(item) ? ' to the bound chat' : ''}`);
  if (sent === Math.ceil(cap * 0.8)) console.warn(`code delivery: telegram ${sent} of ${cap} daily messages used (TELEGRAM_DAILY_CAP)`);
}

/** Доставки этого процесса, ушедшие самому человеку (для строки лога). */
const direct = new WeakSet<CodeItem>();

/** Текст кода самому человеку — как в служебном чате Relay: код моноширинный, предупреждение не пересылать. */
export function directText(item: CodeItem): { text: string; entities: { type: 'code'; offset: number; length: number }[] } {
  const head = 'Код для входа в Relay: ';
  const text = `${head}${item.code}\n\nНикому не сообщайте этот код, даже если его просят от имени Relay. Если вы не входили, ничего не делайте.`;
  return { text, entities: [{ type: 'code', offset: head.length, length: item.code.length }] };
}

/**
 * Код входа или регистрации — в чат с ботом, где этот номер подтверждён контактом. Отказ Telegram (бот заблокирован,
 * чат удалён) — связка снята, код уйдёт владельцу. false — связки нет.
 */
async function sendDirect(item: CodeItem, env: Env): Promise<boolean> {
  if (item.kind === 'recovery' || !item.phone) return false;
  const [link] = await sql`select tg_user_id, chat_id from telegram_links where phone = ${item.phone}`;
  if (!link) return false;
  const { text, entities } = directText(item);
  try {
    await sendTelegram(text, entities, env, Number(link.chat_id));
  } catch (e) {
    if (!(e instanceof PermanentError)) throw e;
    await sql`delete from telegram_links where tg_user_id = ${link.tg_user_id}`;
    console.warn(`code delivery: bound chat refused (${(e as Error).message}), link removed, falling back to the owner`);
    return false;
  }
  direct.add(item);
  return true;
}
