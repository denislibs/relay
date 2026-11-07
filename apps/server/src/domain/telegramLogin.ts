import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from '../db';
import type { Env } from './codeChannel';
import { DomainError } from './errors';
import { botApi } from './telegramBot';

/**
 * «Войти через Telegram» — через бота, а не виджет Telegram Login: виджет не отдаёт номер, а аккаунт Relay — по номеру.
 *   1. Браузер берёт одноразовый токен (5 минут, привязан к ключу устройства) и открывает t.me/<бот>?start=<токен>.
 *   2. Бот на /start <токен> закрепляет попытку за этим аккаунтом Telegram и просит контакт (кнопка request_contact);
 *      если номер этого аккаунта уже подтверждён — спрашивает «Войти в Relay как +7…?» кнопками.
 *   3. Контакт принимается, только если он свой (contact.user_id == from.id); номер берётся только из контакта.
 *   4. Браузер опросом забирает подтверждённый номер — дальше как после верного кода: аккаунт есть — вход
 *      (облачный пароль спросят), нет — регистрация.
 * Связка «аккаунт Telegram → номер» (telegram_links) — для повторного входа кнопкой и для кодов входа самому
 * человеку (codeDelivery.ts). Отвязать — /stop в боте. Вход необязательный: Telegram узнаёт, что человек пользуется Relay.
 */
export const TG_LOGIN_TTL_SEC = 300;
const MAX_PER_IP_HOUR = 20, MAX_PER_TG_HOUR = 10;
const hash = (t: string) => createHash('sha256').update('relay-tg:' + t).digest('hex');
const valid = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);
const PHONE = /^\+[0-9]{7,15}$/;

export const telegramLoginEnabled = (env: Env = process.env): boolean =>
  env.TELEGRAM_LOGIN === '1' && !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_BOT_USERNAME;

/** Начало входа: токен для ссылки на бота. В базе — только хэш; ключ устройства — чтобы забрать вход могло только оно. */
export async function createTelegramLogin(ip: string | null, deviceKey: Uint8Array | null, env: Env = process.env): Promise<{ token: string; url: string; expiresAt: string }> {
  if (!telegramLoginEnabled(env)) throw new DomainError('telegram_unavailable');
  const token = randomBytes(32).toString('base64url');
  await sql`delete from telegram_logins where expires_at < now() - interval '1 day'`;
  const expiresAt = await sql.begin(async (tx) => {
    if (ip) {
      await tx`select pg_advisory_xact_lock(hashtext(${'tg-ip:' + ip}))`;
      const [{ n }] = await tx`select count(*)::int as n from telegram_logins where ip = ${ip} and created_at > now() - interval '1 hour'`;
      if (n >= MAX_PER_IP_HOUR) throw new DomainError('flood');
    }
    const [r] = await tx`
      insert into telegram_logins (id, token_hash, device_key, ip, expires_at)
      values (${randomUUID()}, ${hash(token)}, ${deviceKey ? Buffer.from(deviceKey) : null}, ${ip}, now() + ${TG_LOGIN_TTL_SEC + ' seconds'}::interval)
      returning expires_at`;
    return new Date(r.expires_at as string).toISOString();
  });
  return { token, url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${token}`, expiresAt };
}

/**
 * Опрос из браузера: 'wait' — бот ещё не подтвердил, 'denied' — отменили в боте, 'expired' — нужен новый вход,
 * phone — подтверждённый номер (выдаётся один раз и только устройству, начавшему вход).
 */
export async function pollTelegramLogin(token: unknown, deviceKey: Uint8Array | null): Promise<'wait' | 'denied' | 'expired' | { phone: string }> {
  if (!valid(token)) return 'expired';
  // подтверждённый вход годится ещё минуту после срока: подтверждение могло прийти на последней секунде
  const [r] = await sql`
    update telegram_logins set status = 'used'
     where token_hash = ${hash(token)} and status = 'approved' and expires_at > now() - interval '60 seconds'
       and (device_key is null or device_key = ${deviceKey ? Buffer.from(deviceKey) : null})
     returning phone`;
  if (r) return { phone: r.phone as string };
  const [live] = await sql`select status from telegram_logins where token_hash = ${hash(token)} and expires_at > now()`;
  return live?.status === 'wait' ? 'wait' : live?.status === 'denied' ? 'denied' : 'expired';
}

/** Заголовок X-Telegram-Bot-Api-Secret-Token совпадает с TELEGRAM_WEBHOOK_SECRET (сравнение за постоянное время). */
export function webhookAllowed(req: Request, env: Env = process.env): boolean {
  const want = env.TELEGRAM_WEBHOOK_SECRET, got = req.headers.get('x-telegram-bot-api-secret-token');
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Номер из контакта Telegram (бывает без «+» и с пробелами) — в E.164. */
export const normalizePhone = (raw: string): string | null => {
  const p = '+' + raw.replace(/\D/g, '');
  return PHONE.test(p) ? p : null;
};

type Chat = { id: number; type: string };
type From = { id: number; is_bot?: boolean };
export type BotUpdate = {
  update_id: number;
  message?: { message_id: number; from?: From; chat: Chat; text?: string; contact?: { phone_number: string; user_id?: number } };
  callback_query?: { id: string; from: From; data?: string; message?: { message_id: number; chat: Chat } };
};

const say = (chatId: number, text: string, extra: object = {}, env: Env = process.env) => botApi('sendMessage', { chat_id: chatId, text, ...extra }, env);
const NO_KEYBOARD = { reply_markup: { remove_keyboard: true } };
const TEXT = {
  hello: 'Это бот входа в Relay. Чтобы войти, нажмите «Войти через Telegram» на экране входа Relay.',
  expired: 'Ссылка для входа устарела. Начните вход в Relay заново.',
  flood: 'Слишком много попыток входа. Попробуйте через час.',
  share: 'Чтобы войти в Relay, поделитесь своим номером телефона кнопкой ниже. Relay получит только номер.',
  notOwn: 'Нужен ваш собственный номер — нажмите кнопку «Поделиться номером» ниже.',
  badPhone: 'Не удалось прочитать номер. Войдите в Relay по коду.',
  approved: 'Готово — вернитесь в браузер, вход продолжится там.',
  saved: 'Номер подтверждён: коды входа в Relay будут приходить сюда. Отвязать — /stop.',
  denied: 'Вход отменён.',
  stopped: 'Номер отвязан: коды входа сюда больше не придут. Войти через Telegram можно снова в любой момент.',
};

/** Кнопка «Поделиться номером» под полем ввода. */
const askContact = (chatId: number, env: Env, text = TEXT.share) =>
  say(chatId, text, { reply_markup: { keyboard: [[{ text: 'Поделиться номером', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true } }, env);

/**
 * Обновление от Telegram (webhook или getUpdates). Только личные чаты; ошибки — в лог (без номеров и токенов) и
 * дальше: повтор того же обновления ничего бы не исправил, а очередь Telegram встала бы.
 */
export async function handleBotUpdate(u: BotUpdate, env: Env = process.env): Promise<void> {
  try {
    if (u.message) await onMessage(u.message, env);
    else if (u.callback_query) await onCallback(u.callback_query, env);
  } catch (e) {
    console.warn(`telegram login: update ${u.update_id} failed — ${(e as Error).message}`);
  }
}

async function onMessage(m: NonNullable<BotUpdate['message']>, env: Env): Promise<void> {
  if (m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const me = m.from.id, chat = m.chat.id;
  if (m.contact) return onContact(me, chat, m.contact, env);
  const text = (m.text ?? '').trim();
  if (text === '/stop') {
    await sql`delete from telegram_links where tg_user_id = ${me}`;
    await say(chat, TEXT.stopped, NO_KEYBOARD, env);
    return;
  }
  const start = /^\/start(?:\s+(\S+))?$/.exec(text);
  if (!start?.[1]) { await say(chat, TEXT.hello, {}, env); return; }
  if (!valid(start[1])) { await say(chat, TEXT.expired, {}, env); return; }
  const [{ n }] = await sql`select count(*)::int as n from telegram_logins where tg_user_id = ${me} and created_at > now() - interval '1 hour'`;
  if (n >= MAX_PER_TG_HOUR) { await say(chat, TEXT.flood, {}, env); return; }
  // попытку ведёт тот, кто первым открыл ссылку: пересланная чужому ссылка ему не достанется
  const [a] = await sql`
    update telegram_logins set tg_user_id = ${me}
     where token_hash = ${hash(start[1])} and status = 'wait' and expires_at > now() and (tg_user_id is null or tg_user_id = ${me})
     returning id`;
  if (!a) { await say(chat, TEXT.expired, {}, env); return; }
  const [link] = await sql`select phone from telegram_links where tg_user_id = ${me}`;
  if (!link) { await askContact(chat, env); return; }
  const id = a.id as string;
  await say(chat, `Войти в Relay как ${link.phone}?`, {
    reply_markup: { inline_keyboard: [
      [{ text: 'Войти', callback_data: `tl:ok:${id}` }, { text: 'Отмена', callback_data: `tl:no:${id}` }],
      [{ text: 'Другой номер', callback_data: `tl:new:${id}` }],
    ] },
  }, env);
}

async function onContact(me: number, chat: number, contact: { phone_number: string; user_id?: number }, env: Env): Promise<void> {
  // свой контакт: кнопка request_contact шлёт его с user_id отправителя; пересланная карточка чужого — нет
  if (contact.user_id !== me) { await askContact(chat, env, TEXT.notOwn); return; }
  const phone = normalizePhone(contact.phone_number);
  if (!phone) { await say(chat, TEXT.badPhone, NO_KEYBOARD, env); return; }
  const approved = await sql.begin(async (tx) => {
    await tx`delete from telegram_links where phone = ${phone} and tg_user_id <> ${me}`;
    await tx`insert into telegram_links (tg_user_id, chat_id, phone) values (${me}, ${chat}, ${phone})
             on conflict (tg_user_id) do update set chat_id = excluded.chat_id, phone = excluded.phone, verified_at = now()`;
    const rows = await tx`
      update telegram_logins set status = 'approved', phone = ${phone}
       where id = (select id from telegram_logins where tg_user_id = ${me} and status = 'wait' and expires_at > now() order by created_at desc limit 1)
       returning id`;
    return rows.length > 0;
  });
  await say(chat, approved ? TEXT.approved : TEXT.saved, NO_KEYBOARD, env);
}

async function onCallback(q: NonNullable<BotUpdate['callback_query']>, env: Env): Promise<void> {
  const m = /^tl:(ok|no|new):([0-9a-f-]{36})$/.exec(q.data ?? '');
  const done = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }, env);
  // кнопки под сообщением больше не нужны: текст — итог
  const close = (text: string) => (q.message ? botApi('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text }, env).catch(() => {}) : Promise.resolve());
  if (!m || !q.message || q.message.chat.type !== 'private') { await done(); return; }
  const [kind, id] = [m[1], m[2]];
  const [a] = await sql`select id from telegram_logins where id = ${id} and tg_user_id = ${q.from.id} and status = 'wait' and expires_at > now()`;
  if (!a) { await done('Вход устарел'); await close(TEXT.expired); return; }
  if (kind === 'new') { await done(); await close('Подтвердите другой номер.'); await askContact(q.message.chat.id, env); return; }
  if (kind === 'no') {
    await sql`update telegram_logins set status = 'denied' where id = ${id}`;
    await done(); await close(TEXT.denied); return;
  }
  // номер — из связки, подтверждённой контактом раньше
  const [r] = await sql`
    update telegram_logins l set status = 'approved', phone = k.phone
      from telegram_links k
     where l.id = ${id} and l.status = 'wait' and k.tg_user_id = ${q.from.id}
     returning l.id`;
  if (!r) { await done(); await askContact(q.message.chat.id, env); return; }
  await done(); await close(TEXT.approved);
}

/** Webhook (production): адрес и секрет из окружения. Вызывает воркер при старте; повторный вызов безвреден. */
export async function setupWebhook(env: Env = process.env): Promise<void> {
  await botApi('setWebhook', { url: env.TELEGRAM_WEBHOOK_URL, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] }, env);
  console.log('telegram login: webhook set');
}

/**
 * getUpdates (dev, сервер без входящего HTTPS): один опрашивающий на систему — сессионный advisory-замок на своём
 * соединении; смещение — в telegram_state. Webhook на время опроса снимается (иначе getUpdates отвечает 409).
 */
export function startPolling(env: Env = process.env): { stop(): Promise<void> } {
  let stopped = false;
  const loop = (async () => {
    const conn = await sql.reserve();
    try {
      while (!stopped) {
        const [{ ok }] = await conn`select pg_try_advisory_lock(hashtext('telegram:poll')) as ok`;
        if (ok) break;
        await Bun.sleep(30_000);   // опрашивает другой воркер
      }
      if (stopped) return;
      await botApi('deleteWebhook', {}, env).catch((e) => console.warn(`telegram login: deleteWebhook — ${(e as Error).message}`));
      console.log('telegram login: polling getUpdates');
      while (!stopped) {
        try {
          const [s] = await sql`select v from telegram_state where k = 'offset'`;
          const updates = await botApi<BotUpdate[]>('getUpdates', { offset: s ? Number(s.v) : 0, timeout: 25, allowed_updates: ['message', 'callback_query'] }, env, 35_000);
          for (const u of updates) {
            await handleBotUpdate(u, env);
            await sql`insert into telegram_state (k, v) values ('offset', ${u.update_id + 1}) on conflict (k) do update set v = excluded.v`;
          }
        } catch (e) {
          console.warn(`telegram login: getUpdates — ${(e as Error).message}`);
          await Bun.sleep(5_000);
        }
      }
    } finally {
      await conn`select pg_advisory_unlock_all()`.catch(() => {});
      conn.release();
    }
  })();
  return { async stop() { stopped = true; await loop.catch(() => {}); } };
}
