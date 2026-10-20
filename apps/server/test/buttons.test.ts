import { beforeEach, expect, test } from 'bun:test';
import { parseClientFrame, type Message, type MessageButton, type ServerFrame } from '@relay/protocol';
import { sql } from '../src/db';
import { createSession, sessionFromToken } from '../src/auth';
import { announceLogin, terminateSession } from '../src/domain/sessions';
import { LOGIN_CONFIRMED, LOGIN_ENDED, LOGIN_GONE, LOGIN_OTHERS_ENDED, serviceChatId } from '../src/domain/service';
import { toMessage } from '../src/domain/chats';
import { handleFrame } from '../src/ws';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

/** Пользователь с давним (подтверждённым) сеансом и новым входом по коду (не подтверждён), «Новый вход» — в «Relay». */
async function setup() {
  const userId = await makeUser('Анна');
  const old = (await sessionFromToken(await createSession(userId)))!.sessionId;
  const freshToken = await createSession(userId, undefined, { confirmed: false });
  const fresh = (await sessionFromToken(freshToken))!.sessionId;
  await announceLogin(userId, freshToken);
  const chatId = await serviceChatId(sql, userId);
  const alert = async (): Promise<Message> => toMessage((await sql`select * from messages where chat_id = ${chatId} and service_type = 'new_login' order by id desc limit 1`)[0]);
  const m = await alert();
  return { userId, old, fresh, chatId, id: m.id, alert };
}
const press = (userId: number, sessionId: number | undefined, chatId: number, id: number, data: string) =>
  handleFrame(userId, { op: 'button', reqId: 'b', chatId, id, data }, undefined, sessionId);
const answer = (out: ServerFrame[]) => (out[0] as Extract<ServerFrame, { op: 'ack' }>).result as { toast?: string };
const sessionIds = async (userId: number) => (await sql`select id from sessions where user_id = ${userId} order by id`).map((r) => Number(r.id));

test('«Новый вход» comes with three callback buttons about the new session', async () => {
  const { fresh, alert } = await setup();
  const m = await alert();
  expect(m.buttons).toEqual([
    [{ text: 'Это я', kind: 'callback', data: `login:ok:${fresh}` }, { text: 'Завершить этот сеанс', kind: 'callback', data: `login:end:${fresh}` }],
    [{ text: 'Завершить все остальные сеансы', kind: 'callback', data: `login:others:${fresh}` }],
  ] satisfies MessageButton[][]);
  // журнал несёт кнопки вместе с сообщением
  const [u] = await sql`select payload from updates where type = 'newMessage' order by seq desc limit 1`;
  expect(u.payload.message.buttons).toEqual(m.buttons);
});

test('button frame parsing: data is required and short', () => {
  expect(parseClientFrame(JSON.stringify({ op: 'button', reqId: 'r', chatId: 1, id: 2, data: 'login:ok:3' }))).toEqual({ op: 'button', reqId: 'r', chatId: 1, id: 2, data: 'login:ok:3' });
  for (const data of [undefined, '', 5, 'x'.repeat(65)]) expect(parseClientFrame(JSON.stringify({ op: 'button', reqId: 'r', chatId: 1, id: 2, data }))).toBeNull();
});

test('callback validation: the button must be on that message, in a chat of mine, from «Relay»; a socket session is required', async () => {
  const { userId, old, fresh, chatId, id } = await setup();
  expect(await press(userId, old, chatId, id, 'login:ok:999')).toEqual([{ op: 'err', reqId: 'b', code: 'not_found', retry: false }]);
  expect(await press(userId, old, chatId, id, `login:end:${fresh}x`)).toEqual([{ op: 'err', reqId: 'b', code: 'not_found', retry: false }]);
  expect(await press(userId, undefined, chatId, id, `login:ok:${fresh}`)).toEqual([{ op: 'err', reqId: 'b', code: 'unauthorized', retry: false }]);
  // чужой не нажмёт кнопку в моём «Relay»
  const boris = await makeUser('Борис');
  const bs = (await sessionFromToken(await createSession(boris)))!.sessionId;
  expect(await press(boris, bs, chatId, id, `login:ok:${fresh}`)).toEqual([{ op: 'err', reqId: 'b', code: 'not_member', retry: false }]);
  // кнопки с такой же data у сообщения обычного пользователя сервер не исполняет
  const direct = await makeChat([userId, boris]);
  const [fake] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, buttons)
    values (${direct}, ${boris}, ${crypto.randomUUID()}, 'text', 'жми', ${sql.json([[{ text: 'Да', kind: 'callback', data: `login:others:${fresh}` }]] as never)}) returning id`;
  expect(await press(userId, old, direct, Number(fake.id), `login:others:${fresh}`)).toEqual([{ op: 'err', reqId: 'b', code: 'forbidden', retry: false }]);
  expect(await sessionIds(userId)).toEqual([old, fresh]);
});

test('«Это я» from the old device confirms the login and edits the message: buttons gone, result line in italics', async () => {
  const { userId, old, fresh, chatId, id, alert } = await setup();
  expect(answer(await press(userId, old, chatId, id, `login:ok:${fresh}`))).toEqual({ toast: 'Вход подтверждён' });
  const [s] = await sql`select confirmed_at from sessions where id = ${fresh}`;
  expect(s.confirmed_at).not.toBeNull();
  const m = await alert();
  expect(m.buttons).toBeUndefined();
  expect(m.body.endsWith('\n\n' + LOGIN_CONFIRMED)).toBe(true);
  expect(m.entities?.at(-1)).toEqual({ type: 'italic', offset: m.body.length - LOGIN_CONFIRMED.length, length: LOGIN_CONFIRMED.length });
  expect(m.editedAt).toBeNull();   // правка «бота» — без «изм.»
  const [u] = await sql`select payload from updates where user_id = ${userId} and type = 'messageMarkup' order by seq desc limit 1`;
  expect(u.payload).toEqual({ type: 'messageMarkup', chatId, id, body: m.body, entities: m.entities, buttons: null });
  // кнопок больше нет — второе нажатие не проходит
  expect((await press(userId, old, chatId, id, `login:ok:${fresh}`))[0]).toMatchObject({ op: 'err', code: 'not_found' });
});

test('the new session itself cannot confirm itself, end itself or end the others: toast only, nothing changes', async () => {
  const { userId, old, fresh, chatId, id, alert } = await setup();
  expect(answer(await press(userId, fresh, chatId, id, `login:ok:${fresh}`)).toast).toBe('Подтвердить вход можно только с другого устройства');
  expect(answer(await press(userId, fresh, chatId, id, `login:end:${fresh}`)).toast).toBe('Это текущий сеанс — выйти можно в Настройках');
  expect(answer(await press(userId, fresh, chatId, id, `login:others:${fresh}`)).toast).toMatch(/С нового устройства/);
  expect(await sessionIds(userId)).toEqual([old, fresh]);
  expect((await sql`select confirmed_at from sessions where id = ${fresh}`)[0].confirmed_at).toBeNull();
  expect((await alert()).buttons).toHaveLength(2);
});

test('«Завершить этот сеанс» ends exactly the new session and closes the alert', async () => {
  const { userId, old, fresh, chatId, id, alert } = await setup();
  const third = (await sessionFromToken(await createSession(userId)))!.sessionId;
  expect(answer(await press(userId, old, chatId, id, `login:end:${fresh}`))).toEqual({ toast: 'Сеанс завершён' });
  expect(await sessionIds(userId)).toEqual([old, third]);
  const m = await alert();
  expect(m.buttons).toBeUndefined();
  expect(m.body.endsWith(LOGIN_ENDED)).toBe(true);
});

test('«Завершить все остальные сеансы» keeps only the pressing session; the alerts of ended sessions are closed', async () => {
  const { userId, old, fresh, chatId, id, alert } = await setup();
  await createSession(userId);
  await createSession(userId);
  expect(answer(await press(userId, old, chatId, id, `login:others:${fresh}`))).toEqual({ toast: 'Завершено сеансов: 3' });
  expect(await sessionIds(userId)).toEqual([old]);
  expect((await alert()).body.endsWith(LOGIN_ENDED)).toBe(true);
  // нажали на «Новом входе» о самом этом устройстве — итог «остальные завершены»
  const t2 = await createSession(userId, undefined, { confirmed: false });
  const s2 = (await sessionFromToken(t2))!.sessionId;
  await announceLogin(userId, t2);
  await sql`update sessions set confirmed_at = now() where id = ${s2}`;
  const second = await alert();
  expect(answer(await press(userId, s2, chatId, second.id, `login:others:${s2}`))).toEqual({ toast: 'Завершено сеансов: 1' });
  expect(await sessionIds(userId)).toEqual([s2]);
  expect((await alert()).body.endsWith(LOGIN_OTHERS_ENDED)).toBe(true);
});

test('ending the session from Settings closes its alert; a button about an already ended session says so and drops the buttons', async () => {
  const { userId, old, fresh, chatId, id, alert } = await setup();
  await terminateSession(userId, old, fresh);
  expect((await alert()).body.endsWith(LOGIN_ENDED)).toBe(true);
  expect((await alert()).buttons).toBeUndefined();

  // сеанс исчез мимо этих путей (вышел сам): кнопки ещё висят — нажатие сообщает и убирает их
  const t2 = await createSession(userId, undefined, { confirmed: false });
  const s2 = (await sessionFromToken(t2))!.sessionId;
  await announceLogin(userId, t2);
  const second = await alert();
  await sql`delete from sessions where id = ${s2}`;
  expect(answer(await press(userId, old, chatId, second.id, `login:ok:${s2}`))).toEqual({ toast: 'Этот сеанс уже завершён' });
  const m = await alert();
  expect(m.buttons).toBeUndefined();
  expect(m.body.endsWith(LOGIN_GONE)).toBe(true);
  expect(id).not.toBe(second.id);
});
