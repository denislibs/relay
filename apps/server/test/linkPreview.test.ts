import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { fileFor } from '../src/domain/files';
import { getUpdates } from '../src/domain/journal';
import { brotliCompressSync } from 'node:zlib';
import { allowPrivateHostsForTests, fetchPreview, firstUrl, getPreview, imageSize, isPublicIp, normalizeUrl, resolvePublic } from '../src/domain/linkPreview';
import { applyLinkPreview, sendMessage } from '../src/domain/messages';
import { makeChat, makeUser, opened, resetDb } from './helpers';

beforeEach(resetDb);
const cid = () => crypto.randomUUID();

// PNG 64×48 (только заголовок и IHDR — для размеров этого хватает)
const png = (() => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); const dv = new DataView(b.buffer); dv.setUint32(16, 64); dv.setUint32(20, 48); return b; })();
const page = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === '/img.png') return new Response(png, { headers: { 'content-type': 'image/png' } });
  if (u.pathname === '/moved') return Response.redirect('/page', 302);
  // сервер, который сжимает, даже когда не просили
  if (u.pathname === '/br') return new Response(brotliCompressSync('<html><head><title>Сжато</title></head></html>'), { headers: { 'content-type': 'text/html', 'content-encoding': 'br' } });
  if (u.pathname === '/enc') return new Response(`<html><head><title>${req.headers.get('accept-encoding')}</title></head></html>`, { headers: { 'content-type': 'text/html' } });
  return new Response(`<html><head><meta charset="utf-8"><title>Док</title>
    <meta property="og:site_name" content="Тест Магазин"><meta property="og:title" content="Телефон  S25">
    <meta name="description" content="Описание товара"><meta property="og:image" content="/img.png"></head><body>x</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
} });
afterAll(() => { page.stop(); allowPrivateHostsForTests(false); });
const base = `http://localhost:${page.port}`;

test('first url: text link or formatted link, trailing punctuation dropped, www gets https', () => {
  expect(firstUrl('смотри https://kaspi.kz/shop/p/x-1/, круто')).toBe('https://kaspi.kz/shop/p/x-1/');
  expect(firstUrl('тут www.example.com.')).toBe('https://www.example.com/');
  expect(firstUrl('жми сюда', [{ type: 'link', offset: 0, length: 4, url: 'https://a.b/c' }])).toBe('https://a.b/c');
  expect(firstUrl('без ссылок')).toBeNull();
  expect(normalizeUrl('ftp://x.y')).toBeNull();
  expect(normalizeUrl('https://user:pw@x.y/')).toBeNull();
  expect(normalizeUrl('https://x.y:8080/')).toBeNull();
});

test('private and service addresses are never fetched', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPublicIp(ip)).toBe(false);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) expect(isPublicIp(ip)).toBe(true);
  allowPrivateHostsForTests(false);
  expect(await getPreview('http://127.0.0.1/')).toBeNull();
  expect(await getPreview('http://localhost/admin')).toBeNull();
});

test('CVE-2026-111497: previews ask for no compression and never decompress a compressed answer', async () => {
  allowPrivateHostsForTests(true);
  expect((await fetchPreview(`${base}/enc`))?.title).toBe('identity');
  await expect(fetchPreview(`${base}/br`)).rejects.toThrow('compressed');
});

test('image size from the file header', () => {
  expect(imageSize(png)).toEqual({ w: 64, h: 48, mime: 'image/png' });
  expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
});

test('send with a link: pending at once, the job fills the preview, members get linkPreview, image is readable', async () => {
  allowPrivateHostsForTests(true);
  const a = await makeUser(), b = await makeUser(), stranger = await makeUser();
  const chat = await makeChat([a, b]);
  const url = `${base}/moved`;
  const { message } = await sendMessage(a, { chatId: chat, clientId: cid(), body: 'глянь ' + url });
  expect(message.link).toEqual({ url: url, pending: true });
  await applyLinkPreview({ chatId: chat, id: message.id, url: message.link!.url });
  const [row] = await opened(await sql`select * from messages where id = ${message.id}`);
  expect(row.link).toMatchObject({ url, siteName: 'Тест Магазин', title: 'Телефон S25', description: 'Описание товара', photo: { w: 64, h: 48 } });
  const ups = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(ups.find((u) => u.type === 'linkPreview')).toMatchObject({ chatId: chat, id: message.id, link: { title: 'Телефон S25' } });
  expect(await fileFor(stranger, row.link.photo.id)).not.toBeNull();   // картинка превью — публичная, как сама страница
  // тот же адрес снова: ответ — тоже «грузится» (по ответу не понять, слал ли ссылку кто-то ещё — CRYPTO-4);
  // задача берёт превью из кэша и адрес — из шифра сообщения (в задаче его нет)
  const again = await sendMessage(b, { chatId: chat, clientId: cid(), body: url });
  expect(again.message.link).toEqual({ url, pending: true });
  const [job] = await sql`select payload from jobs where kind = 'link.preview' order by id desc limit 1`;
  expect(job.payload).toEqual({ chatId: chat, id: again.message.id });
  await applyLinkPreview(job.payload as never);
  const [row2] = await opened(await sql`select * from messages where id = ${again.message.id}`);
  expect(row2.link).toMatchObject({ title: 'Телефон S25' });
  // в кэше — ни адреса, ни заголовка открытым текстом
  const cache = await sql`select * from link_previews`;
  expect(JSON.stringify(cache)).not.toContain('Телефон');
  expect(JSON.stringify(cache)).not.toContain('localhost');
});

test('noLinkPreview, attachments and plain text get no preview', async () => {
  allowPrivateHostsForTests(true);
  const a = await makeUser(), b = await makeUser();
  const chat = await makeChat([a, b]);
  const off = await sendMessage(a, { chatId: chat, clientId: cid(), body: `${base}/page`, noLinkPreview: true });
  expect(off.message.link ?? null).toBeNull();
  const plain = await sendMessage(a, { chatId: chat, clientId: cid(), body: 'привет' });
  expect(plain.message.link ?? null).toBeNull();
});

test('SSRF-1: IPv4 hidden inside IPv6 in any spelling, NAT64, 6to4, site-local and documentation ranges are not public', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::808:808', '2002:7f00:1::1', 'fec0::1', '2001:db8::1', '100::1', '198.51.100.7', '203.0.113.9', '192.0.2.1', '240.0.0.1'])
    expect(isPublicIp(ip)).toBe(false);
  // URL-парсер превращает [::ffff:127.0.0.1] в [::ffff:7f00:1] — и это тоже не проходит
  const host = new URL('http://[::ffff:127.0.0.1]/').hostname;
  expect(host).toBe('[::ffff:7f00:1]');
  await expect(resolvePublic(host)).rejects.toThrow('private');
  await expect(resolvePublic('localhost')).rejects.toThrow('private');
  expect(await resolvePublic('8.8.8.8')).toBe('8.8.8.8');
});
