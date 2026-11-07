import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { sql } from '../src/db';
import { createSession } from '../src/auth';
import { requestCode, signIn } from '../src/domain/login';
import { deliver } from '../src/domain/devOutbox';
import { maskTo, telegramText } from '../src/domain/codeDelivery';
import { drainJobs } from '../src/jobs/worker';
import '../src/jobs/kinds';
import { makeUser, resetDb } from './helpers';

// Bot API без сети: свой сервер на случайном порту отвечает как api.telegram.org и копит сообщения
const TOKEN = '123456:TEST-token-not-real';
const sent: { path: string; body: { chat_id: string; text: string; entities: { type: string; offset: number; length: number }[] } }[] = [];
let reply: () => Response = () => Response.json({ ok: true, result: { message_id: 1 } });
const bot = Bun.serve({
  port: 0,
  async fetch(req) {
    sent.push({ path: new URL(req.url).pathname, body: await req.json() });
    return reply();
  },
});
afterAll(() => bot.stop(true));

const ENV = { CODE_DELIVERY: 'telegram', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_CHAT_ID: '777', TELEGRAM_API_URL: `http://127.0.0.1:${bot.port}` };
const lines: string[] = [];
let spies: { mockRestore(): void }[] = [];
beforeEach(async () => {
  await resetDb();
  await sql`delete from code_deliveries`;
  sent.length = 0;
  lines.length = 0;
  reply = () => Response.json({ ok: true, result: { message_id: 1 } });
  Object.assign(process.env, ENV);
  const keep = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  spies = [spyOn(console, 'log').mockImplementation(keep), spyOn(console, 'warn').mockImplementation(keep)];
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  for (const s of spies) s.mockRestore();
});

/** Код из последнего сообщения бота — по сущности code, как его скопировал бы владелец. */
const lastCode = () => {
  const m = sent.at(-1)!.body;
  const e = m.entities.find((x) => x.type === 'code')!;
  return m.text.slice(e.offset, e.offset + e.length);
};
/** Токен и коды в логе не появляются ни в каком виде. */
const logIsClean = (code?: string) => {
  for (const l of lines) {
    expect(l).not.toContain(TOKEN);
    if (code) expect(l).not.toContain(code);
  }
};

test('signup of a new number: the code goes to the owner chat after commit, the number signs up with it', async () => {
  const r = await requestCode('+79990001122');
  expect(r.devCode).toBeUndefined();
  expect(sent).toHaveLength(0);   // не в запросе — задачей воркера
  expect(await drainJobs()).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0].path).toBe(`/bot${TOKEN}/sendMessage`);
  expect(sent[0].body.chat_id).toBe('777');
  expect(sent[0].body.text).toContain('регистрация нового номера');
  expect(sent[0].body.text).toContain('+79990001122');
  expect(sent[0].body.text).toMatch(/Действует до \d\d:\d\d \(UTC\)/);
  const code = lastCode();
  expect(code).toMatch(/^\d{5}$/);
  expect(await signIn(r.attemptId, code)).toEqual({ signupPhone: '+79990001122' });
  logIsClean(code);
  expect(lines.some((l) => l.includes('code delivery: telegram signup for +79') && l.endsWith('sent'))).toBe(true);
  // сырой код не остаётся в очереди
  expect(await sql`select 1 from jobs`).toHaveLength(0);
});

test('an existing user without sessions gets a code; with an open session the code stays in the app', async () => {
  const id = await makeUser('Вера');
  await sql`update users set username = 'vera_x' where id = ${id}`;
  const r = await requestCode('@vera_x');
  await drainJobs();
  expect(sent).toHaveLength(1);
  expect(sent[0].body.text).toContain('Relay — вход');
  expect(sent[0].body.text).toContain('Логин: vera_x');
  expect(await signIn(r.attemptId, lastCode())).toEqual({ userId: id });

  await createSession(id);
  sent.length = 0;
  await requestCode('@vera_x');
  await drainJobs();
  expect(sent).toHaveLength(0);
  // неизвестное имя: регистрации нет и владельцу ничего не уходит
  await requestCode('@nobody_q');
  await drainJobs();
  expect(sent).toHaveLength(0);
});

test('a failed send is retried; a refusal (403) is not, and the dead job keeps no code', async () => {
  let fails = 1;
  reply = () => (fails-- > 0 ? Response.json({ ok: false, description: 'Bad Gateway' }, { status: 502 }) : Response.json({ ok: true, result: {} }));
  const r = await requestCode('+79990003344');
  await drainJobs();
  expect(sent).toHaveLength(1);
  const [job] = await sql`select attempts, last_error, run_at > now() as later from jobs where kind = 'code.deliver'`;
  expect(job).toMatchObject({ attempts: 1, later: true });
  expect(job.last_error).toBe('telegram: 502 Bad Gateway');
  await sql`update jobs set run_at = now()`;
  await drainJobs();
  expect(sent).toHaveLength(2);
  expect(await signIn(r.attemptId, lastCode())).toEqual({ signupPhone: '+79990003344' });
  expect(await sql`select 1 from jobs`).toHaveLength(0);

  reply = () => Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
  await requestCode('+79990005566');
  await drainJobs();
  const [dead] = await sql`select payload, last_error from jobs_dead where kind = 'code.deliver'`;
  expect(dead.last_error).toContain('403');
  expect(dead.payload.secret).toBeUndefined();
  expect(Object.keys(dead.payload).sort()).toEqual(['expiresAt', 'kind', 'phone', 'to']);
  logIsClean(lastCode());
  expect(lines.some((l) => l.includes('failed — telegram: 403'))).toBe(true);
});

test('network errors never leak the token (it is in the request URL)', async () => {
  process.env.TELEGRAM_API_URL = 'http://127.0.0.1:1';   // порт закрыт
  await requestCode('+79990007788');
  await drainJobs();
  const [job] = await sql`select last_error from jobs where kind = 'code.deliver'`;
  expect(job.last_error).toMatch(/^telegram: request failed/);
  expect(job.last_error).not.toContain(TOKEN);
  logIsClean();
});

test('daily cap: over it nothing is sent, with a warning; expired codes are dropped', async () => {
  process.env.TELEGRAM_DAILY_CAP = '2';
  try {
    for (const n of ['+79990000001', '+79990000002', '+79990000003']) await requestCode(n);
    await drainJobs();
    expect(sent).toHaveLength(2);
    expect(lines.some((l) => l.includes('daily cap 2 reached'))).toBe(true);
    expect(lines.some((l) => l.includes('2 of 2 daily messages used'))).toBe(true);
  } finally { delete process.env.TELEGRAM_DAILY_CAP; }

  await sql`delete from code_deliveries`;
  sent.length = 0;
  await requestCode('+79990000004');
  await sql`update jobs set payload = jsonb_set(payload, '{expiresAt}', to_jsonb((now() - interval '1 minute')::text))`;
  await drainJobs();
  expect(sent).toHaveLength(0);
  expect(lines.some((l) => l.includes('expired before delivery'))).toBe(true);
});

test('recovery codes (mail.recovery) go the same way', async () => {
  await deliver({ to: 'maria@example.com', kind: 'recovery', code: '123456', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  expect(sent).toHaveLength(1);
  expect(sent[0].body.text).toContain('восстановление пароля');
  expect(sent[0].body.text).toContain('Почта: maria@example.com');
  expect(lastCode()).toBe('123456');
  logIsClean('123456');
});

test('message text and log masks', () => {
  const t = telegramText({ to: '+79990001122', kind: 'login', code: '04213', expiresAt: '2026-11-07T10:05:00Z' }, { CODE_TIME_ZONE: 'Europe/Moscow' });
  expect(t.text).toBe('Relay — вход\nНомер: +79990001122\nКод: 04213\nДействует до 13:05 (Europe/Moscow)');
  expect(t.entities).toContainEqual({ type: 'code', offset: t.text.indexOf('04213'), length: 5 });
  expect(maskTo('+79990001122')).toBe('+79•••••••22');
  expect(maskTo('anna')).toBe('a•••');
  expect(maskTo('maria@example.com')).toBe('m•••@example.com');
});
