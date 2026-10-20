import type { Entity, Message, MessageButton, ServiceType } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { toMessage } from './chats';
import { fanOut } from './journal';
import { enqueue } from '../jobs/queue';

type Db = Tx | typeof sql;
let systemId: Promise<number> | null = null;

/** Системный пользователь «Relay» (строка из миграции 110_service). Кэшируется на процесс. */
export function systemUserId(): Promise<number> {
  return systemId ??= sql`select id from users where system limit 1`.then(([r]) => {
    if (!r) throw new Error('system user missing: run migrations');
    return Number(r.id);
  }).catch((e) => { systemId = null; throw e; });
}

/** Служебный чат пользователя: создаётся при первом служебном сообщении, дальше один и тот же. */
export async function serviceChatId(db: Db, userId: number): Promise<number> {
  const [found] = await db`select chat_id from service_chats where user_id = ${userId}`;
  if (found) return Number(found.chat_id);
  const sys = await systemUserId();
  const [chat] = await db`insert into chats (kind, title) values ('direct', null) returning id`;
  await db`insert into chat_members (chat_id, user_id) values (${chat.id}, ${userId}), (${chat.id}, ${sys})`;
  // гонка двух первых сообщений: побеждает первая вставка, лишний чат удаляем
  const [won] = await db`insert into service_chats (user_id, chat_id) values (${userId}, ${chat.id}) on conflict (user_id) do nothing returning chat_id`;
  if (won) return Number(won.chat_id);
  await db`delete from chats where id = ${chat.id}`;
  const [r] = await db`select chat_id from service_chats where user_id = ${userId}`;
  return Number(r.chat_id);
}

export async function isServiceChat(db: Db, chatId: number): Promise<boolean> {
  const [r] = await db`select 1 from service_chats where chat_id = ${chatId}`;
  return !!r;
}

/** Служебное сообщение пользователю: строка messages, newMessage в журнал и задача push — всё в транзакции вызывающего. */
export async function postService(tx: Tx, userId: number, msg: { type: ServiceType; body: string; entities?: Entity[]; buttons?: MessageButton[][] }, opts: { push?: boolean } = {}): Promise<Message> {
  const chatId = await serviceChatId(tx, userId);
  const sys = await systemUserId();
  const [row] = await tx`
    insert into messages (chat_id, sender_id, client_id, kind, body, entities, service_type, buttons)
    values (${chatId}, ${sys}, ${crypto.randomUUID()}, 'text', ${msg.body}, ${msg.entities?.length ? tx.json(msg.entities as never) : null}, ${msg.type},
            ${msg.buttons?.length ? tx.json(msg.buttons as never) : null})
    returning *`;
  const message = toMessage(row);
  await fanOut(tx, [userId], { type: 'newMessage', message });
  if (opts.push !== false) await enqueue(tx, 'push.message', { message });
  await enqueue(tx, 'search.sync', { id: message.id });   // коды входа обработчик сам не проиндексирует
  return message;
}

/**
 * «Новый вход»: устройство, IP и время, совет, что делать, если это не вы; заголовок жирным.
 * sessionId — новый сеанс: под сообщением кнопки «Это я», «Завершить этот сеанс», «Завершить все остальные сеансы».
 */
export function newLoginMessage(device: string, ip: string | null, at: Date, sessionId?: number): { body: string; entities: Entity[]; buttons?: MessageButton[][] } {
  const when = at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const title = 'Новый вход в аккаунт';
  const body = `${title}\n\nУстройство: ${device}\nIP: ${ip ?? 'неизвестен'}\nВремя: ${when}\n\nЕсли это были не вы, завершите этот сеанс — кнопкой ниже или в Настройках → Активные сеансы.`;
  return { body, entities: [{ type: 'bold', offset: 0, length: title.length }], ...(sessionId != null ? { buttons: loginButtons(sessionId) } : {}) };
}

/** Кнопки «Нового входа»: data — login:<действие>:<id нового сеанса>. */
export function loginButtons(sessionId: number): MessageButton[][] {
  return [
    [{ text: 'Это я', kind: 'callback', data: `login:ok:${sessionId}` }, { text: 'Завершить этот сеанс', kind: 'callback', data: `login:end:${sessionId}` }],
    [{ text: 'Завершить все остальные сеансы', kind: 'callback', data: `login:others:${sessionId}` }],
  ];
}

/** Сеанс, о котором «Новый вход» (по data его кнопок); null — кнопок нет или они чужие. */
export function loginSessionOf(buttons: unknown): number | null {
  if (!Array.isArray(buttons)) return null;
  for (const row of buttons) for (const b of Array.isArray(row) ? row : []) {
    const m = /^login:\w+:(\d{1,15})$/.exec((b as MessageButton)?.data ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

/** Итоги под «Новым входом» после нажатия (или того же действия в Настройках). */
export const LOGIN_CONFIRMED = 'Вы подтвердили этот вход.';
export const LOGIN_ENDED = 'Сеанс завершён.';
export const LOGIN_GONE = 'Этот сеанс уже завершён.';
export const LOGIN_OTHERS_ENDED = 'Все остальные сеансы завершены.';

/**
 * Закрыть «Новый вход» о сеансах ids: кнопки убираются, в конец текста — итог курсивом (как бот правит своё сообщение
 * после нажатия). Сообщения без кнопок не трогаем — итог пишется один раз.
 */
export async function resolveLoginAlerts(tx: Tx, userId: number, ids: number[], note: string): Promise<void> {
  if (!ids.length) return;
  const [svc] = await tx`select chat_id from service_chats where user_id = ${userId}`;
  if (!svc) return;
  const rows = await tx`
    select id, body, entities, buttons from messages
     where chat_id = ${svc.chat_id} and service_type = 'new_login' and buttons is not null and not deleted
     for update`;
  for (const r of rows) {
    const sid = loginSessionOf(r.buttons);
    if (sid == null || !ids.includes(sid)) continue;
    const body = `${r.body as string}\n\n${note}`;
    const entities: Entity[] = [...((r.entities as Entity[] | null) ?? []), { type: 'italic', offset: body.length - note.length, length: note.length }];
    const id = Number(r.id);
    await tx`update messages set body = ${body}, entities = ${tx.json(entities as never)}, buttons = null where chat_id = ${svc.chat_id} and id = ${id}`;
    await fanOut(tx, [userId], { type: 'messageMarkup', chatId: Number(svc.chat_id), id, body, entities, buttons: null });
    await enqueue(tx, 'search.sync', { id });
  }
}

/**
 * Приветствие нового пользователя: что такое Relay, с чего начать, что сюда приходит.
 * Собирается кусками, чтобы смещения форматирования считались сами: [текст, стиль?].
 */
export function welcomeMessage(): { body: string; entities: Entity[] } {
  const parts: [string, Entity['type']?][] = [
    ['Добро пожаловать в Relay 👋', 'bold'],
    ['\n\nRelay работает даже без сети: переписка хранится на устройстве, а сообщения уйдут сами, как только появится интернет.\n\n'],
    ['С чего начать', 'bold'],
    ['\n• '], ['Фото профиля', 'bold'], [' — Настройки → нажмите на свой кружок. Можно поставить и GIF или видео.'],
    ['\n• '], ['Новый чат или группа', 'bold'], [' — круглая кнопка с карандашом внизу списка чатов.'],
    ['\n• '], ['Ссылки', 'bold'], [' на GitHub, Instagram и другие профили — Настройки → Изменить профиль.'],
    ['\n• '], ['Оформление текста', 'bold'], [': выделите слова и выберите стиль — '], ['жирный', 'bold'], [', '], ['курсив', 'italic'], [', '], ['зачёркнутый', 'strike'], [', '], ['спойлер', 'spoiler'], ['.'],
    ['\n• '], ['Голосовые', 'bold'], [' — микрофон справа от поля ввода.'],
    ['\n\nСюда будут приходить коды входа и предупреждения о новых входах в аккаунт. Писать сюда можно, но ответа не будет 🙂'],
  ];
  let body = '';
  const entities: Entity[] = [];
  for (const [text, type] of parts) {
    if (type) entities.push({ type, offset: body.length, length: text.length });
    body += text;
  }
  return { body, entities };
}

const ensured = new Set<number>();
/**
 * Служебный чат «Relay» есть у каждого с первого входа (как «Telegram» в Telegram): нет — создаём с приветствием
 * (без push). Вызывается на GET /me; проверка в базе — один раз на процесс для пользователя.
 */
export async function ensureServiceChat(userId: number): Promise<void> {
  // тесты движка (SERVICE_CHAT=off) считают чаты пользователя точно — приветственный «Relay» им лишний
  if (process.env.SERVICE_CHAT === 'off') return;
  if (ensured.has(userId)) return;
  const [has] = await sql`select 1 from service_chats where user_id = ${userId}`;
  if (!has) {
    await sql.begin((tx) => postService(tx, userId, { type: 'welcome', ...welcomeMessage() }, { push: false }));
  }
  ensured.add(userId);
}
