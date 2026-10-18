import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { resetDb } from './helpers';

process.env.FILES_DIR = '/tmp/relay-test-files';
const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });

test('upload a photo, send it, members can download it, strangers cannot; media list', async () => {
  const a = await login('Анна'), b = await login('Борис'), c = await login('Чужой');
  const { id: chatId } = (await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number };
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const up = await (await fetch(`${base}/upload?name=cat.png&w=800&h=600`, { method: 'POST', headers: { ...as(a.token), 'content-type': 'image/png' }, body: png })).json() as { id: string; kind: string; w: number };
  expect(up).toMatchObject({ kind: 'photo', w: 800, h: 600, size: png.length, name: 'cat.png' });

  // чужое вложение отправить нельзя
  const { sendMessage } = await import('../src/domain/messages');
  await expect(sendMessage(b.userId, { chatId, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id } })).rejects.toMatchObject({ code: 'not_found' });
  const { message } = await sendMessage(a.userId, { chatId, clientId: crypto.randomUUID(), body: 'котик', attachment: { id: up.id, thumb: 'data:image/jpeg;base64,AAAA' } });
  expect(message).toMatchObject({ kind: 'photo', attachment: { id: up.id, w: 800, h: 600, thumb: 'data:image/jpeg;base64,AAAA' } });

  const asB = await fetch(`${base}/files/${up.id}`, { headers: as(b.token) });
  expect(asB.status).toBe(200);
  expect(asB.headers.get('content-type')).toBe('image/png');
  expect(new Uint8Array(await asB.arrayBuffer())).toEqual(png);
  expect((await fetch(`${base}/files/${up.id}`, { headers: as(c.token) })).status).toBe(404);
  const dl = await fetch(`${base}/files/${up.id}?download=1`, { headers: as(a.token) });
  expect(dl.headers.get('content-disposition')).toContain('attachment');

  const media = await (await fetch(`${base}/chats/${chatId}/media?kind=photo`, { headers: as(b.token) })).json() as { messages: { id: number }[] };
  expect(media.messages.map((m) => m.id)).toEqual([message.id]);
  const doc = await (await fetch(`${base}/upload?name=report.pdf`, { method: 'POST', headers: { ...as(a.token), 'content-type': 'application/pdf' }, body: 'pdf' })).json() as { kind: string };
  expect(doc.kind).toBe('file');
});

test('HTML, SVG and other active types are never served inline from our origin', async () => {
  const a = await login('Анна');
  for (const [mime, name] of [['text/html', 'x.html'], ['image/svg+xml', 'x.svg'], ['application/xhtml+xml', 'x.xhtml'], ['application/pdf', 'x.pdf']]) {
    const up = await (await fetch(`${base}/upload?name=${name}`, { method: 'POST', headers: { ...as(a.token), 'content-type': mime }, body: '<script>alert(1)</script>' })).json() as { id: string };
    const res = await fetch(`${base}/files/${up.id}`, { headers: as(a.token) });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toStartWith('attachment');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  }
  const img = await (await fetch(`${base}/upload?name=p.png&w=2&h=2`, { method: 'POST', headers: { ...as(a.token), 'content-type': 'image/png' }, body: new Uint8Array([137, 80]) })).json() as { id: string };
  const res = await fetch(`${base}/files/${img.id}`, { headers: as(a.token) });
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('content-disposition')).toStartWith('inline');
});
