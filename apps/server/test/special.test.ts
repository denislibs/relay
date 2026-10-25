import { afterAll, beforeEach, expect, test } from 'bun:test';
import { DICE_FACES, geoTile, normalizeGeo, parseClientFrame } from '@relay/protocol';
import { sql } from '../src/db';
import { getHistory } from '../src/domain/chats';
import { editMessage } from '../src/domain/messageOps';
import { rollDice, sendMessage } from '../src/domain/messages';
import { createServer } from '../src/http';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
const server = createServer({ port: 0 });
afterAll(() => server.stop(true));
const send = (from: number, chatId: number, o: Record<string, unknown>) => sendMessage(from, { chatId, clientId: crypto.randomUUID(), body: '', ...o });

test('normalizeGeo and frames: ranges, rounding, venue text', () => {
  expect(normalizeGeo({ lat: 55.7558261, lng: 37.6172999, title: '  Красная\nплощадь ' })).toEqual({ lat: 55.755826, lng: 37.6173, title: 'Красная площадь' });
  expect(normalizeGeo({ lat: 91, lng: 0 })).toBeNull();
  expect(normalizeGeo({ lat: 'x', lng: 0 })).toBeNull();
  expect(parseClientFrame(JSON.stringify({ op: 'send', reqId: 'r', clientId: crypto.randomUUID(), chatId: 1, body: '', dice: { emoji: '🍕' } }))).toBeNull();
  expect(geoTile(0, 0, 1)).toEqual({ x: 1, y: 1, px: 0, py: 0 });
});

test('location and venue: no text of their own, sealed, not editable', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const { message } = await send(a, chat, { body: 'игнор', geo: { lat: 59.93863, lng: 30.31413, title: 'Эрмитаж', address: 'Дворцовая пл., 2' } });
  expect(message).toMatchObject({ kind: 'geo', body: 'Эрмитаж', geo: { lat: 59.93863, lng: 30.31413, title: 'Эрмитаж', address: 'Дворцовая пл., 2' } });
  const [row] = await sql`select data, content from messages where chat_id = ${chat} and id = ${message.id}`;
  if (row.content) expect(row.data).toBeNull();   // координаты — в шифре
  const { message: plain } = await send(a, chat, { geo: { lat: 1, lng: 2 } });
  expect(plain).toMatchObject({ kind: 'geo', body: '', geo: { lat: 1, lng: 2 } });
  await expect(send(a, chat, { geo: { lat: 100, lng: 0 } })).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(editMessage(a, chat, message.id, 'текст')).rejects.toMatchObject({ code: 'forbidden' });
  expect((await getHistory(b, chat, null, 10)).messages.find((m) => m.id === message.id)?.geo?.title).toBe('Эрмитаж');
});

test('dice: the server rolls, forwarding keeps the value', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]), other = await makeChat([a, b]);
  const { message } = await send(a, chat, { body: '🎲', dice: { emoji: '🎲' } });
  expect(message.kind).toBe('dice');
  expect(message.dice!.emoji).toBe('🎲');
  expect(message.dice!.value).toBeGreaterThanOrEqual(1);
  expect(message.dice!.value).toBeLessThanOrEqual(6);
  const { message: fwd } = await send(b, other, { forward: { chatId: chat, id: message.id } });
  expect(fwd.dice).toEqual(message.dice);
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) seen.add(rollDice('🎰'));
  expect(Math.min(...seen)).toBeGreaterThanOrEqual(1);
  expect(Math.max(...seen)).toBeLessThanOrEqual(DICE_FACES['🎰']);
  expect(seen.size).toBeGreaterThan(50);
});

test('contact: a Relay user by id, name at send time, unknown id is not found', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]);
  const { message } = await send(a, chat, { contact: { userId: c } });
  expect(message).toMatchObject({ kind: 'contact', body: 'Вера', contact: { userId: c, name: 'Вера' } });
  await expect(send(a, chat, { contact: { userId: 999999 } })).rejects.toMatchObject({ code: 'not_found' });
});

test('map tiles only for signed-in users; out-of-range tiles are 404', async () => {
  const base = `http://localhost:${server.port}`;
  expect((await fetch(`${base}/maptile/10/1/1.png`)).status).toBe(401);
  const { token } = await (await fetch(`${base}/dev/login`, { method: 'POST', body: JSON.stringify({ name: 'Анна' }) })).json() as { token: string };
  expect((await fetch(`${base}/maptile/30/1/1.png`, { headers: { cookie: `relay_session=${token}` } })).status).toBeOneOf([401, 404]);
});
