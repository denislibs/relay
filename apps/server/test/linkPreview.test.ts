import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { fileFor } from '../src/domain/files';
import { getUpdates } from '../src/domain/journal';
import { allowPrivateHostsForTests, firstUrl, getPreview, imageSize, isPublicIp, normalizeUrl } from '../src/domain/linkPreview';
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
  // тот же адрес снова — превью из кэша сразу, без задачи
  const again = await sendMessage(b, { chatId: chat, clientId: cid(), body: url });
  expect(again.message.link).toMatchObject({ title: 'Телефон S25' });
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
