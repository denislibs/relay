import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { createSession } from '../src/auth';
import { requestCode, signIn } from '../src/domain/login';
import { sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, resetDb } from './helpers';

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
  const [msg] = await sql`select body, service_type from messages where service_type = 'login_code' order by id desc limit 1`;
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
