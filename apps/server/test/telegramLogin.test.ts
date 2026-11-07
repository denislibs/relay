import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { sql } from '../src/db';
import { createServer } from '../src/http';
import { requestCode, signIn } from '../src/domain/login';
import { startPolling, type BotUpdate } from '../src/domain/telegramLogin';
import { drainJobs } from '../src/jobs/worker';
import '../src/jobs/kinds';
import { resetDb } from './helpers';

// «Войти через Telegram»: Bot API — свой Bun.serve (без сети), обновления бота — POST на webhook, как от Telegram
type Call = { method: string; body: Record<string, any> };
const calls: Call[] = [];
// фото профиля в «Telegram»: размеры от маленького к большому, как отдаёт Bot API
let tgPhotos: { file_id: string; width: number; height: number }[][] = [];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const queue: BotUpdate[] = [];
let refuse: ((c: Call) => Response | null) = () => null;
const bot = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    // скачивание файла: /file/bot<токен>/<file_path>
    if (path.startsWith('/file/')) { calls.push({ method: 'file', body: { path } }); return new Response(JPEG, { headers: { 'content-type': 'application/octet-stream' } }); }
    const method = path.split('/').pop()!;
    const c = { method, body: (await req.json().catch(() => ({}))) as Record<string, any> };
    calls.push(c);
    const no = refuse(c);
    if (no) return no;
    if (method === 'getUpdates') return Response.json({ ok: true, result: queue.splice(0) });
    if (method === 'getUserProfilePhotos') return Response.json({ ok: true, result: { total_count: tgPhotos.length, photos: tgPhotos } });
    if (method === 'getFile') return Response.json({ ok: true, result: { file_id: c.body.file_id, file_path: 'photos/file_7.jpg', file_size: JPEG.length } });
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: calls.length } : true });
  },
});
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => { server.stop(true); bot.stop(true); });

const SECRET = 'test-webhook-secret-123';
const ENV = {
  TELEGRAM_LOGIN: '1', TELEGRAM_BOT_TOKEN: '42:TEST', TELEGRAM_BOT_USERNAME: 'relay_test_bot', TELEGRAM_OWNER_CHAT_ID: '1',
  TELEGRAM_API_URL: `http://127.0.0.1:${bot.port}`, TELEGRAM_WEBHOOK_SECRET: SECRET,
};
let spies: { mockRestore(): void }[] = [];
const lines: string[] = [];
beforeEach(async () => {
  await resetDb();
  await sql`truncate telegram_logins, telegram_links, telegram_state, code_deliveries`;
  calls.length = 0; queue.length = 0; lines.length = 0;
  refuse = () => null;
  tgPhotos = [];
  Object.assign(process.env, ENV);
  const keep = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  spies = [spyOn(console, 'log').mockImplementation(keep), spyOn(console, 'warn').mockImplementation(keep)];
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), 'CODE_DELIVERY']) delete process.env[k];
  for (const s of spies) s.mockRestore();
});

async function call(path: string, data: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(data) });
  const set = res.headers.getSetCookie?.() ?? [];
  const session = set.find((c) => /relay_session=[^;]/.test(c))?.split(';')[0] ?? null;
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any>, session };
}
async function deviceOf() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const key = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  return async () => {
    const { nonce } = (await (await fetch(base + '/session/challenge')).json()) as { nonce: string };
    const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`relay-device|bind|${nonce}`))).toString('base64');
    return { key, nonce, sig };
  };
}
let updateId = 1;
const hook = (u: Omit<BotUpdate, 'update_id'>, secret = SECRET) => call('/auth/telegram/webhook', { update_id: updateId++, ...u }, { 'x-telegram-bot-api-secret-token': secret });
const msg = (from: number, extra: object) => ({ message: { message_id: updateId, from: { id: from }, chat: { id: from, type: 'private' }, ...extra } });
const said = (chat: number) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chat));
const tokenOf = (url: string) => new URL(url).searchParams.get('start')!;

test('new number: link → /start → own contact → the browser signs up with the verified phone', async () => {
  expect((await (await fetch(base + '/auth/config')).json())).toMatchObject({ telegram: true });
  const device = await deviceOf();
  const start = await call('/auth/telegram', { device: await device() });
  expect(start.json.url).toMatch(/^https:\/\/t\.me\/relay_test_bot\?start=[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(start.json.url);
  expect((await call('/auth/telegram/poll', { token, device: await device() })).json).toEqual({ status: 'wait' });

  // без секрета заголовка (или с чужим) webhook не принимает ничего
  expect((await hook(msg(501, { text: `/start ${token}` }), 'wrong-secret-0000000')).status).toBe(404);
  expect(calls).toHaveLength(0);

  await hook(msg(501, { text: `/start ${token}` }));
  const ask = said(501).at(-1)!;
  expect(ask.body.reply_markup.keyboard[0][0]).toMatchObject({ request_contact: true });

  // чужая карточка контакта (переслали) не годится
  await hook(msg(501, { contact: { phone_number: '+79990001111', user_id: 999 } }));
  expect((await call('/auth/telegram/poll', { token, device: await device() })).json).toEqual({ status: 'wait' });

  await hook(msg(501, { contact: { phone_number: '7 999 111-22-33', user_id: 501 } }));
  expect(said(501).at(-1)!.body.text).toContain('вернитесь в браузер');
  const step = await call('/auth/telegram/poll', { token, device: await device() });
  expect(step.json).toMatchObject({ signupRequired: true, phone: '+79991112233' });
  const done = await call('/auth/signup', { pendingId: step.json.pendingId, firstName: 'Телега', device: await device() });
  expect(done.status).toBe(200);
  const [u] = await sql`select phone from users where id = ${done.json.userId}`;
  expect(u.phone).toBe('+79991112233');
  // выдаётся один раз
  expect((await call('/auth/telegram/poll', { token, device: await device() })).json).toEqual({ status: 'expired' });
  expect([...(await sql`select tg_user_id, chat_id from telegram_links where phone = '+79991112233'`)]).toEqual([{ tg_user_id: 501, chat_id: 501 }]);
  for (const l of lines) expect(l).not.toContain('+79991112233');
});

test('new number: name and photo from Telegram prefill the signup form; the photo is served only through us, once signed up nothing stays', async () => {
  tgPhotos = [[{ file_id: 'small-160', width: 160, height: 160 }, { file_id: 'big-640', width: 640, height: 640 }, { file_id: 'huge-1280', width: 1280, height: 1280 }]];
  const device = await deviceOf();
  const token = tokenOf((await call('/auth/telegram', { device: await device() })).json.url);
  const from = { id: 801, first_name: 'Полина', last_name: 'Павлова' };
  await hook({ message: { message_id: 1, from, chat: { id: 801, type: 'private' }, text: `/start ${token}` } });
  await hook({ message: { message_id: 2, from, chat: { id: 801, type: 'private' }, contact: { phone_number: '+79990008888', user_id: 801 } } });
  expect(calls.find((c) => c.method === 'getUserProfilePhotos')!.body).toMatchObject({ user_id: 801, limit: 1 });

  const step = await call('/auth/telegram/poll', { token, device: await device() });
  expect(step.json).toMatchObject({ signupRequired: true, phone: '+79990008888', prefill: { firstName: 'Полина', lastName: 'Павлова', photo: true } });
  // в попытке входа подсказка больше не хранится
  expect([...(await sql`select tg_first, tg_last, tg_photo from telegram_logins`)]).toEqual([{ tg_first: null, tg_last: null, tg_photo: null }]);

  // фото — байтами через сервер: самый крупный размер до 800, адрес с токеном бота наружу не уходит
  const photo = await fetch(base + '/auth/signup/photo', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ pendingId: step.json.pendingId }) });
  expect(photo.status).toBe(200);
  expect(photo.headers.get('content-type')).toBe('image/jpeg');
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);
  expect(calls.find((c) => c.method === 'getFile')!.body).toEqual({ file_id: 'big-640' });
  // чужая или выдуманная заявка — ничего
  const none = await fetch(base + '/auth/signup/photo', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ pendingId: crypto.randomUUID() }) });
  expect(none.status).toBe(404);

  // имя в профиль — то, что человек подтвердил в форме, а не из Telegram
  const done = await call('/auth/signup', { pendingId: step.json.pendingId, firstName: 'Поля', lastName: '', device: await device() });
  expect(done.status).toBe(200);
  const [u] = await sql`select first_name, last_name, photo from users where id = ${done.json.userId}`;
  expect(u).toEqual({ first_name: 'Поля', last_name: null, photo: null });
  expect([...(await sql`select prefill from login_pending where id = ${step.json.pendingId}`)]).toEqual([{ prefill: null }]);
  const again = await fetch(base + '/auth/signup/photo', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ pendingId: step.json.pendingId }) });
  expect(again.status).toBe(404);
});

test('prefill: hidden photo or a failing Bot API leaves names only; an existing account gets no prefill and no photo lookup', async () => {
  refuse = (c) => (c.method === 'getUserProfilePhotos' ? new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 500 }) : null);
  const device = await deviceOf();
  let token = tokenOf((await call('/auth/telegram', { device: await device() })).json.url);
  const from = { id: 802, first_name: 'Ян' };
  await hook({ message: { message_id: 1, from, chat: { id: 802, type: 'private' }, text: `/start ${token}` } });
  await hook({ message: { message_id: 2, from, chat: { id: 802, type: 'private' }, contact: { phone_number: '+79990009999', user_id: 802 } } });
  expect((await call('/auth/telegram/poll', { token, device: await device() })).json).toMatchObject({ signupRequired: true, prefill: { firstName: 'Ян', lastName: '', photo: false } });

  // уже есть аккаунт: вход как раньше, Telegram о фото не спрашиваем
  refuse = () => null;
  calls.length = 0;
  await sql`insert into users (name, phone) values ('Вера', '+79990002223')`;
  token = tokenOf((await call('/auth/telegram', { device: await device() })).json.url);
  const vera = { id: 803, first_name: 'Другое имя' };
  await hook({ message: { message_id: 3, from: vera, chat: { id: 803, type: 'private' }, text: `/start ${token}` } });
  await hook({ message: { message_id: 4, from: vera, chat: { id: 803, type: 'private' }, contact: { phone_number: '+79990002223', user_id: 803 } } });
  const r = await call('/auth/telegram/poll', { token, device: await device() });
  expect(r.json).toHaveProperty('userId');
  expect(r.json).not.toHaveProperty('prefill');
  expect(calls.some((c) => c.method === 'getUserProfilePhotos')).toBe(false);
});

test('only the device that started the login takes it; a link forwarded to another Telegram account is dead for it', async () => {
  const owner = await deviceOf(), other = await deviceOf();
  const token = tokenOf((await call('/auth/telegram', { device: await owner() })).json.url);
  await hook(msg(501, { text: `/start ${token}` }));
  await hook(msg(777, { text: `/start ${token}` }));
  expect(said(777).at(-1)!.body.text).toContain('устарела');
  await hook(msg(777, { contact: { phone_number: '+79990007777', user_id: 777 } }));
  expect((await call('/auth/telegram/poll', { token, device: await owner() })).json).toEqual({ status: 'wait' });
  await hook(msg(501, { contact: { phone_number: '+79990005555', user_id: 501 } }));
  const stolen = await call('/auth/telegram/poll', { token, device: await other() });
  expect(stolen.json).toEqual({ status: 'expired' });
  expect(stolen.session).toBeNull();
  expect((await call('/auth/telegram/poll', { token, device: await owner() })).json).toMatchObject({ signupRequired: true, phone: '+79990005555' });
});

test('returning user: «Войти как …?» — confirm signs in to the existing account (unconfirmed session); cancel is reported', async () => {
  const [{ id }] = await sql`insert into users (name, phone) values ('Вера', '+79990002222') returning id`;
  await sql`insert into telegram_links (tg_user_id, chat_id, phone) values (601, 601, '+79990002222')`;
  const device = await deviceOf();
  const token = tokenOf((await call('/auth/telegram', { device: await device() })).json.url);
  await hook(msg(601, { text: `/start ${token}` }));
  const ask = said(601).at(-1)!;
  expect(ask.body.text).toBe('Войти в Relay как +79990002222?');
  const ok = ask.body.reply_markup.inline_keyboard[0][0].callback_data as string;
  expect(ok).toMatch(/^tl:ok:/);
  // чужой аккаунт Telegram нажать за него не может
  await hook({ callback_query: { id: 'q0', from: { id: 999 }, data: ok, message: { message_id: 1, chat: { id: 999, type: 'private' } } } });
  expect((await call('/auth/telegram/poll', { token, device: await device() })).json).toEqual({ status: 'wait' });
  await hook({ callback_query: { id: 'q1', from: { id: 601 }, data: ok, message: { message_id: 1, chat: { id: 601, type: 'private' } } } });
  expect(calls.some((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'q1')).toBe(true);
  const r = await call('/auth/telegram/poll', { token, device: await device() });
  expect(r.json).toEqual({ userId: Number(id) });
  expect(r.session).not.toBeNull();
  const [s] = await sql`select login_method, confirmed_at is not null as confirmed from sessions where user_id = ${id}`;
  expect(s).toMatchObject({ login_method: 'telegram', confirmed: false });

  const t2 = tokenOf((await call('/auth/telegram', { device: await device() })).json.url);
  await hook(msg(601, { text: `/start ${t2}` }));
  const no = said(601).at(-1)!.body.reply_markup.inline_keyboard[0][1].callback_data as string;
  await hook({ callback_query: { id: 'q2', from: { id: 601 }, data: no, message: { message_id: 2, chat: { id: 601, type: 'private' } } } });
  expect((await call('/auth/telegram/poll', { token: t2, device: await device() })).json).toEqual({ status: 'denied' });

  // /stop — связка снята
  await hook(msg(601, { text: '/stop' }));
  expect(await sql`select 1 from telegram_links where tg_user_id = 601`).toHaveLength(0);
});

test('rate limits: per address and per Telegram account', async () => {
  process.env.RELAY_TG_LOGIN_PER_IP_HOUR = '20';   // по умолчанию 120 (CGNAT); механизм тот же
  try {
    for (let i = 0; i < 20; i++) expect((await call('/auth/telegram', {})).status).toBe(200);
    expect((await call('/auth/telegram', {})).json).toMatchObject({ code: 'flood', retryAfter: expect.any(Number) });
  } finally { delete process.env.RELAY_TG_LOGIN_PER_IP_HOUR; }

  await sql`truncate telegram_logins`;
  const tokens: string[] = [];
  for (let i = 0; i < 11; i++) tokens.push(tokenOf((await call('/auth/telegram', {})).json.url));
  for (const t of tokens) await hook(msg(701, { text: `/start ${t}` }));
  expect(said(701).at(-1)!.body.text).toContain('Слишком много');
  expect((await sql`select count(*)::int as n from telegram_logins where tg_user_id = 701`)[0].n).toBe(10);
});

test('disabled: no button in config, no tokens', async () => {
  delete process.env.TELEGRAM_LOGIN;
  expect((await (await fetch(base + '/auth/config')).json())).toMatchObject({ telegram: false });
  expect((await call('/auth/telegram', {})).json).toEqual({ code: 'telegram_unavailable' });
});

test('phase 2: a login code for a bound phone goes to that person, not the owner; a refused chat falls back to the owner', async () => {
  process.env.CODE_DELIVERY = 'telegram';
  const [{ id }] = await sql`insert into users (name, phone) values ('Гоша', '+79990003333') returning id`;
  await sql`insert into telegram_links (tg_user_id, chat_id, phone) values (801, 801, '+79990003333')`;
  const r = await requestCode('+79990003333');
  await drainJobs();
  const direct = said(801).at(-1)!;
  expect(direct.body.text).toStartWith('Код для входа в Relay: ');
  expect(said(1)).toHaveLength(0);
  const e = direct.body.entities[0];
  expect(await signIn(r.attemptId, direct.body.text.slice(e.offset, e.offset + e.length))).toEqual({ userId: Number(id) });

  // бот заблокирован человеком: связка снята, код — владельцу
  refuse = (c) => (c.body.chat_id === 801 ? Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 }) : null);
  await requestCode('+79990003333');
  await drainJobs();
  expect(said(1)).toHaveLength(1);
  expect(said(1)[0].body.text).toContain('+79990003333');
  expect(await sql`select 1 from telegram_links where tg_user_id = 801`).toHaveLength(0);
});

test('getUpdates polling: updates are handled and the offset is kept', async () => {
  const token = tokenOf((await call('/auth/telegram', {})).json.url);
  queue.push({ update_id: 900, ...msg(901, { text: `/start ${token}` }) } as BotUpdate);
  const p = startPolling();
  for (let i = 0; i < 100 && !said(901).length; i++) await Bun.sleep(20);
  await p.stop();
  expect(calls.find((c) => c.method === 'deleteWebhook')).toBeDefined();
  expect(said(901).at(-1)!.body.reply_markup.keyboard[0][0].request_contact).toBe(true);
  expect((await sql`select v from telegram_state where k = 'offset'`)[0].v).toBe(901);
});
