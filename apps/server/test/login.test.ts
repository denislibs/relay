import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createSession } from '../src/auth';
import { requestCode, signIn } from '../src/domain/login';
import { sendMessage } from '../src/domain/messages';
import { editMessage } from '../src/domain/messageOps';
import { makeChat, makeUser, opened, resetDb } from './helpers';

beforeEach(resetDb);
process.env.DEV_LOGIN = '1';   // devCode в ответе: SMS нет, код читаем как «второе устройство»

async function userWithSession(name: string, username: string) {
  const id = await makeUser(name);
  await sql`update users set username = ${username} where id = ${id}`;
  await createSession(id);
  return id;
}

test('code goes to the service chat of a user with a session; right code signs in once', async () => {
  const a = await userWithSession('Анна', 'anna_x');
  const r = await requestCode('@anna_x');
  expect(r).toMatchObject({ via: 'app', length: 5 });
  const [msg] = await opened(await sql`select * from messages where service_type = 'login_code' order by id desc limit 1`);
  expect(msg.body).toContain(r.devCode!);
  expect(await signIn(r.attemptId, r.devCode!)).toEqual({ userId: a });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });   // одноразовый
});

test('wrong codes: five tries, then the attempt is gone; unknown login looks the same', async () => {
  await userWithSession('Борис', 'boris');
  const r = await requestCode('@boris');
  for (let i = 0; i < 5; i++) await expect(signIn(r.attemptId, '00000')).rejects.toMatchObject({ code: 'code_invalid' });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });
  const ghost = await requestCode('@nobody');
  expect(ghost).toMatchObject({ via: 'app', length: 5 });   // существование аккаунта не раскрываем
  expect(ghost.devCode).toBeUndefined();
  await expect(signIn(ghost.attemptId, '12345')).rejects.toMatchObject({ code: 'code_invalid' });
});

test('at most five codes an hour', async () => {
  await userWithSession('Вера', 'vera_x');
  for (let i = 0; i < 5; i++) await requestCode('@vera_x');
  await expect(requestCode('@vera_x')).rejects.toMatchObject({ code: 'flood' });
});

test('a code sent in a message is burned', async () => {
  const a = await userWithSession('Гена', 'gena_x');
  const b = await makeUser('Злоумышленник');
  const chat = await makeChat([a, b]);
  const r = await requestCode('@gena_x');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: `вот код ${r.devCode}` });
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'code_expired' });
});

test('request -> five wrong -> request does not reset the hourly limit', async () => {
  await userWithSession('Дима', 'dima_x');
  for (let i = 0; i < 5; i++) {
    const r = await requestCode('@dima_x');
    for (let j = 0; j < 5; j++) await signIn(r.attemptId, '00000').catch(() => {});
  }
  await expect(requestCode('@dima_x')).rejects.toMatchObject({ code: 'flood' });
});

test('fifteen wrong tries an hour on one target: signIn answers flood', async () => {
  await userWithSession('Егор', 'egor_x');
  for (let i = 0; i < 3; i++) {
    const r = await requestCode('@egor_x');
    for (let j = 0; j < 5; j++) await expect(signIn(r.attemptId, '00000')).rejects.toMatchObject({ code: 'code_invalid' });
  }
  const r = await requestCode('@egor_x');
  await expect(signIn(r.attemptId, r.devCode!)).rejects.toMatchObject({ code: 'flood' });
});

test('unknown login hits the hourly limit just like a real one', async () => {
  for (let i = 0; i < 5; i++) await requestCode('@nobody_x');
  await expect(requestCode('@NoBody_x')).rejects.toMatchObject({ code: 'flood' });
});

test('per-IP limit: 30 an hour', async () => {
  for (let i = 0; i < 30; i++) await requestCode('@ghost_' + i, '10.0.0.7');
  await expect(requestCode('@ghost_x', '10.0.0.7')).rejects.toMatchObject({ code: 'flood' });
  await requestCode('@ghost_x', '10.0.0.8');
});

test('old attempts are swept on request', async () => {
  const r = await requestCode('@old_ghost');
  await sql`update login_attempts set created_at = now() - interval '2 days' where id = ${r.attemptId}`;
  await requestCode('@other_ghost');
  expect(await sql`select 1 from login_attempts where id = ${r.attemptId}`).toHaveLength(0);
});

test('no live session: the stored hash is unmatchable outside dev', async () => {
  const id = await makeUser('Жора');
  await sql`update users set username = 'zhora_x' where id = ${id}`;
  process.env.DEV_LOGIN = '0';
  try {
    const r = await requestCode('@zhora_x');
    const ghost = await requestCode('@nobody_y');
    expect(Object.keys(r).sort()).toEqual(Object.keys(ghost).sort());   // ответ тот же, что у неизвестного логина
    expect(r).toMatchObject({ via: 'app', length: 5 });
    expect(r.devCode).toBeUndefined();
    for (let c = 0; c < 200; c++) await signIn(r.attemptId, String(c).padStart(5, '0')).catch(() => {});
    const [row] = await sql`select dead_at from login_attempts where id = ${r.attemptId}`;
    expect(row.dead_at).not.toBeNull();
  } finally { process.env.DEV_LOGIN = '1'; }
});

test('codes split by separators or glued to digits are burned; editing burns too', async () => {
  const a = await userWithSession('Зина', 'zina_x');
  const b = await makeUser('Чужой');
  const chat = await makeChat([a, b]);
  const forged = async (code: string) => {
    const r = await requestCode('@zina_x');
    await sql`update login_attempts set code_hash = ${new Bun.CryptoHasher('sha256').update('relay-login:' + code).digest('hex')} where id = ${r.attemptId}`;
    return r.attemptId;
  };
  const one = await forged('12345');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'код 112345' });
  await expect(signIn(one, '12345')).rejects.toMatchObject({ code: 'code_expired' });
  const two = await forged('54321');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'код 54 321' });
  await expect(signIn(two, '54321')).rejects.toMatchObject({ code: 'code_expired' });
  const three = await forged('99887');
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'привет' });
  await editMessage(a, chat, message.id, 'код 99-887');
  await expect(signIn(three, '99887')).rejects.toMatchObject({ code: 'code_expired' });
});

test('hourly limit is per account too: 3 codes by phone + 3 by username → the sixth is flood', async () => {
  const a = await userWithSession('Ира', 'ira_x');
  await sql`update users set phone = '+79005550101' where id = ${a}`;
  for (let i = 0; i < 3; i++) await requestCode('+79005550101');
  for (let i = 0; i < 2; i++) await requestCode('@ira_x');
  await expect(requestCode('@ira_x')).rejects.toMatchObject({ code: 'flood' });
  await expect(requestCode('+79005550101')).rejects.toMatchObject({ code: 'flood' });
  // по строке логина неизвестный логин считается как раньше и аккаунт не задевает
  await requestCode('@nobody_ira');
});

test('burnCodes bounds its work: digit runs over 64 are ignored, candidates are capped', async () => {
  const a = await userWithSession('Костя', 'kostya_x');
  const b = await makeUser('Чужой');
  const chat = await makeChat([a, b]);
  const forged = async (code: string) => {
    const r = await requestCode('@kostya_x');
    await sql`update login_attempts set code_hash = ${new Bun.CryptoHasher('sha256').update('relay-login:' + code).digest('hex')} where id = ${r.attemptId}`;
    return r.attemptId;
  };
  // длинная серия цифр — не код: попытка жива
  const long = await forged('24680');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: '24680' + '1'.repeat(60) });
  expect((await sql`select dead_at from login_attempts where id = ${long}`)[0].dead_at).toBeNull();
  // кандидатов не больше 256: код в начале сгорает, за пределом — нет
  const first = await forged('13579');
  const late = await forged('97531');
  const filler = Array.from({ length: 300 }, (_, i) => String(10000 + i)).join(' x ');
  await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: `13579 x ${filler} x 97531` });
  expect((await sql`select dead_at from login_attempts where id = ${first}`)[0].dead_at).not.toBeNull();
  expect((await sql`select dead_at from login_attempts where id = ${late}`)[0].dead_at).toBeNull();
});
