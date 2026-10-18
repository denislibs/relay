import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createServer } from '../src/http';
import { getUpdates } from '../src/domain/journal';
import { getHistory } from '../src/domain/chats';
import { markListened } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { resetDb, uploadFile } from './helpers';

const server = createServer({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(resetDb);
const login = async (name: string) => (await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name }) })).json()) as { userId: number; token: string };
const as = (t: string) => ({ cookie: `relay_session=${t}` });
const wave = Buffer.from(Array.from({ length: 63 }, (_, i) => i * 4)).toString('base64');

async function chatOf(a: { userId: number; token: string }, b: { userId: number }) {
  return ((await (await fetch(`${base}/dev/chats`, { method: 'POST', headers: as(a.token), body: JSON.stringify({ kind: 'direct', title: null, memberIds: [a.userId, b.userId] }) })).json()) as { id: number }).id;
}
/** qs — как прежние параметры /upload: name=…&kind=…&duration=…; тело уходит по подписанной ссылке */
const upload = (t: string, qs: string, mime: string, body: Uint8Array) => {
  const p = Object.fromEntries(new URLSearchParams(qs));
  const n = (k: string) => (p[k] ? Number(p[k]) : undefined);
  return uploadFile(base, t, { name: p.name, mime, kind: p.kind, waveform: p.waveform, duration: n('duration'), w: n('w'), h: n('h') }, body);
};

test('voice and round uploads keep duration and waveform; wrong types or durations fall back to a plain file', async () => {
  const a = await login('Анна');
  const ogg = new Uint8Array(2000).fill(7);
  expect(await upload(a.token, `name=audio.ogg&kind=voice&duration=7&waveform=${encodeURIComponent(wave)}`, 'audio/ogg', ogg))
    .toMatchObject({ kind: 'voice', duration: 7, waveform: wave, w: null });
  // волна не 63 байта — без волны, но голосовое
  expect(await upload(a.token, 'name=a.ogg&kind=voice&duration=3&waveform=AAAA', 'audio/ogg', ogg)).toMatchObject({ kind: 'voice', duration: 3 });
  expect((await upload(a.token, 'name=a.ogg&kind=voice&duration=3&waveform=AAAA', 'audio/ogg', ogg)).waveform).toBeUndefined();
  expect(await upload(a.token, 'name=video.mp4&kind=round&duration=12&w=400&h=400', 'video/mp4', ogg)).toMatchObject({ kind: 'round', duration: 12, w: 400, h: 400 });
  // кружок длиннее минуты, не квадрат, голосовое картинкой — обычные файлы
  expect((await upload(a.token, 'name=v.mp4&kind=round&duration=90&w=400&h=400', 'video/mp4', ogg)).kind).toBe('file');
  expect((await upload(a.token, 'name=v.mp4&kind=round&duration=5&w=400&h=300', 'video/mp4', ogg)).kind).toBe('file');
  expect((await upload(a.token, 'name=x.png&kind=voice&duration=5', 'image/png', ogg)).kind).toBe('file');
});

test('a voice message is listened once by the recipient; everyone hears about it; the sender cannot mark it', async () => {
  const a = await login('Анна'), b = await login('Борис');
  const chat = await chatOf(a, b);
  const up = await upload(a.token, `name=audio.ogg&kind=voice&duration=2&waveform=${encodeURIComponent(wave)}`, 'audio/ogg', new Uint8Array(500));
  const { message } = await sendMessage(a.userId, { chatId: chat, clientId: crypto.randomUUID(), body: '', attachment: { id: up.id as string } });
  expect(message).toMatchObject({ kind: 'voice', listened: false, attachment: { kind: 'voice', duration: 2, waveform: wave } });
  expect(await markListened(a.userId, chat, message.id)).toEqual({ changed: false });
  expect(await markListened(b.userId, chat, message.id)).toEqual({ changed: true });
  expect(await markListened(b.userId, chat, message.id)).toEqual({ changed: false });
  const evA = (await getUpdates(a.userId, 0)).items.map((i) => i.update).filter((u) => u.type === 'mediaListened');
  expect(evA).toEqual([{ type: 'mediaListened', chatId: chat, id: message.id }]);
  expect((await getHistory(a.userId, chat, null, 5)).messages[0]).toMatchObject({ listened: true });
  const text = await sendMessage(a.userId, { chatId: chat, clientId: crypto.randomUUID(), body: 'текст' });
  await expect(markListened(b.userId, chat, text.message.id)).rejects.toMatchObject({ code: 'bad_frame' });
});

test('media files are served in ranges through the signed link (seeking in audio and video)', async () => {
  const a = await login('Анна');
  const body = new Uint8Array(1000).map((_, i) => i % 256);
  const up = await upload(a.token, 'name=video.mp4&kind=round&duration=3&w=400&h=400', 'video/mp4', body);
  const r = await fetch(`${base}/files/${up.id}`, { headers: { ...as(a.token), range: 'bytes=100-199' } });
  expect(r.status).toBe(206);
  expect(r.headers.get('content-range')).toBe('bytes 100-199/1000');
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(body.slice(100, 200));
});
