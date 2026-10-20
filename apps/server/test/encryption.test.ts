import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { sendMessage, applyLinkPreview } from '../src/domain/messages';
import { editMessage, deleteMessage } from '../src/domain/messageOps';
import { saveDraft } from '../src/domain/drafts';
import { getHistory, getChatMedia, listChats } from '../src/domain/chats';
import { searchPostgres } from '../src/domain/search';
import { encryptLegacyStep } from '../src/domain/messageContent';
import { getUpdates } from '../src/domain/journal';
import '../src/jobs/kinds';
import { drainJobs } from '../src/jobs/worker';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

const SECRET = 'код от сейфа 7319';
const dump = async () => JSON.stringify({
  messages: await sql`select * from messages`, drafts: await sql`select * from drafts`, updates: await sql`select * from updates`,
  jobs: await sql`select * from jobs`, dead: await sql`select * from jobs_dead`,
}, (_k, v) => (v && v.type === 'Buffer' ? '<bytes>' : v));
const send = (u: number, chatId: number, body: string, extra: Record<string, unknown> = {}) => sendMessage(u, { chatId, clientId: crypto.randomUUID(), body, ...extra });

test('nothing readable is left in the database: message, edit, draft, journal and job queue hold no text', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await send(a, chat, SECRET);
  await editMessage(a, chat, message.id, SECRET + ' (исправлено)');
  await saveDraft(b, chat, SECRET + ' черновик');
  expect(await dump()).not.toContain('сейфа');
  // а клиенту всё как раньше
  expect((await getHistory(b, chat, null, 10)).messages[0].body).toBe(SECRET + ' (исправлено)');
  const chats = await listChats(b);
  expect(chats[0].last?.body).toBe(SECRET + ' (исправлено)');
  expect(chats[0].draft?.text).toBe(SECRET + ' черновик');
});

test('each chat has its own key; a forward is re-sealed with the target chat key', async () => {
  const a = await makeUser('a'), b = await makeUser('b'), c = await makeUser('c');
  const ab = await makeChat([a, b]), ac = await makeChat([a, c]);
  const { message } = await send(a, ab, SECRET);
  const fwd = await sendMessage(a, { chatId: ac, clientId: crypto.randomUUID(), body: '', forward: { chatId: ab, id: message.id } });
  expect(fwd.message.body).toBe(SECRET);
  expect((await getHistory(c, ac, null, 10)).messages[0].body).toBe(SECRET);
  const [x, y] = await sql`select chat_id, content from messages where content is not null order by id`;
  expect(Buffer.from(x.content).equals(Buffer.from(y.content))).toBe(false);
  expect((await sql`select count(distinct chat_id)::int n from keys.chat_keys`)[0].n).toBe(2);
});

test('a cipher copied into another row does not open there (AAD binds it to its chat and client id)', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const one = (await send(a, chat, SECRET)).message, two = (await send(a, chat, 'безобидное')).message;
  await sql`update messages set content = (select content from messages where id = ${one.id}) where id = ${two.id}`;
  await expect(getHistory(a, chat, null, 10)).rejects.toMatchObject({ code: 'tampered' });
});

test('attachment names and the link preview live in the cipher; the Links tab still finds links', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await send(a, chat, 'смотри https://example.com/сейф', { noLinkPreview: false });
  await applyLinkPreview({ chatId: chat, id: message.id, url: message.link?.url ?? 'https://example.com/сейф' }).catch(() => {});
  const [row] = await sql`select body, link, has_link from messages where id = ${message.id}`;
  expect(row).toMatchObject({ body: '', link: null, has_link: true });
  const links = await getChatMedia(b, chat, 'link', null);
  expect(links.messages.map((m) => m.id)).toEqual([message.id]);
});

test('deleting a message wipes its cipher too', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await send(a, chat, SECRET);
  await deleteMessage(a, chat, message.id);
  const [row] = await sql`select body, content, deleted from messages where id = ${message.id}`;
  expect(row).toMatchObject({ body: '', content: null, deleted: true });
});

test('push jobs carry only a reference, delivery jobs a sealed payload', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await send(a, chat, SECRET);
  const [job] = await sql`select payload from jobs where kind = 'push.message'`;
  expect(Object.keys(job.payload).sort()).toEqual(['chatId', 'id']);
  await drainJobs();
  expect(await dump()).not.toContain('сейфа');
});

test('search without the index finds encrypted messages (scan with decryption)', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await send(a, chat, 'ничего интересного');
  const hit = (await send(a, chat, 'где ключ от СЕЙФА?')).message;
  const r = await searchPostgres(b, 'сейфа');
  expect(r.hits.map((h) => h.message.id)).toEqual([hit.id]);
});

test('rows written before encryption are read as is, and the crypto.encrypt job seals them (resumable, idempotent)', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  for (let i = 0; i < 3; i++) await sql`insert into messages (chat_id, sender_id, client_id, body) values (${chat}, ${a}, ${crypto.randomUUID()}, ${'старое ' + i + ' ' + SECRET})`;
  await sql`insert into drafts (user_id, chat_id, text) values (${b}, ${chat}, ${'старый черновик ' + SECRET})`;
  expect((await getHistory(b, chat, null, 10)).messages.map((m) => m.body.slice(0, 7))).toEqual(['старое ', 'старое ', 'старое ']);
  const first = await encryptLegacyStep(0, 2);
  expect(first).toMatchObject({ encrypted: 2, done: false });
  const second = await encryptLegacyStep(first.next, 2);
  expect(second.encrypted).toBe(1);
  const last = await encryptLegacyStep(second.next, 2);
  expect(last).toMatchObject({ done: true, encrypted: 1 });   // черновик
  expect(await dump()).not.toContain('сейфа');
  expect((await getHistory(b, chat, null, 10)).messages.map((m) => m.body)).toEqual([0, 1, 2].map((i) => 'старое ' + i + ' ' + SECRET));
  expect((await listChats(b))[0].draft?.text).toBe('старый черновик ' + SECRET);
  expect(await encryptLegacyStep(0)).toMatchObject({ encrypted: 0, done: true });
});

test('a vanished chat key (crypto-shredding) turns its messages into empty ones instead of failing', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  await send(a, chat, SECRET);
  await sql`delete from keys.chat_keys where chat_id = ${chat}`;
  (await import('../src/crypto/chatKeys')).forgetChat(chat);
  const ups = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(ups[0]).toMatchObject({ type: 'newMessage', message: { body: '' } });
});
