import { afterAll, beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { getChatMedia, getChatMediaCounts } from '../src/domain/chats';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);
afterAll(() => {});

async function put(chatId: number, sender: number, kind: string, body: string, attachment: object | null = null, entities: object | null = null, service: string | null = null) {
  const [r] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment, entities, service_type)
    values (${chatId}, ${sender}, ${crypto.randomUUID()}, ${kind}, ${body}, ${attachment ? sql.json(attachment as never) : null}, ${entities ? sql.json(entities as never) : null}, ${service}) returning id`;
  return Number(r.id);
}

test('shared media tabs: photo and video files are media, music and voice/round apart, links from text or entities', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Чужой');
  const chat = await makeChat([a, b]);
  const att = (kind: string, mime: string) => ({ id: crypto.randomUUID(), kind, mime, name: 'x', size: 1, w: null, h: null });
  const photo = await put(chat, a, 'photo', '', att('photo', 'image/png'));
  const video = await put(chat, a, 'file', '', att('file', 'video/mp4'));
  const pdf = await put(chat, b, 'file', '', att('file', 'application/pdf'));
  const song = await put(chat, b, 'audio', '', { ...att('audio', 'audio/mpeg'), duration: 120 });
  const voice = await put(chat, a, 'voice', '', att('voice', 'audio/ogg'));
  const round = await put(chat, a, 'round', '', att('round', 'video/mp4'));
  const link1 = await put(chat, a, 'text', 'смотри https://example.com');
  const link2 = await put(chat, a, 'text', 'тут', null, [{ type: 'link', offset: 0, length: 3, url: 'https://x.y' }]);
  await put(chat, a, 'text', 'без ссылок');
  await put(chat, a, 'text', 'www', null);
  await put(chat, a, 'text', 'Код https://relay.app', null, null, 'login_code');   // служебное — не ссылка
  const gone = await put(chat, a, 'photo', '', att('photo', 'image/png'));
  await sql`update messages set deleted = true where chat_id = ${chat} and id = ${gone}`;

  const ids = async (tab: Parameters<typeof getChatMedia>[2]) => (await getChatMedia(b, chat, tab, null)).messages.map((m) => m.id);
  expect(await ids('media')).toEqual([video, photo]);
  expect(await ids('file')).toEqual([pdf]);
  expect(await ids('audio')).toEqual([song]);
  expect(await ids('voice')).toEqual([round, voice]);
  expect(await ids('link')).toEqual([link2, link1]);
  expect(await getChatMediaCounts(a, chat)).toEqual({ media: 2, file: 1, audio: 1, voice: 2, link: 2 });
  await expect(getChatMediaCounts(c, chat)).rejects.toMatchObject({ code: 'not_member' });
});

test('pages go back by id', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const list: number[] = [];
  for (let i = 0; i < 5; i++) list.push(await put(chat, a, 'audio', '', { id: crypto.randomUUID(), kind: 'audio', mime: 'audio/mpeg', name: i + '.mp3', size: 1, w: null, h: null, duration: 60 }));
  const p1 = await getChatMedia(a, chat, 'audio', null, 2);
  expect(p1.messages.map((m) => m.id)).toEqual([list[4], list[3]]);
  expect(p1.hasMore).toBe(true);
  const p3 = await getChatMedia(a, chat, 'audio', list[1], 2);
  expect(p3.messages.map((m) => m.id)).toEqual([list[0]]);
  expect(p3.hasMore).toBe(false);
});

test('an audio file with a duration is music; without one, or a voice-kind request, it is not', async () => {
  const a = await makeUser('Анна');
  const { createUpload } = await import('../src/domain/files');
  const kindOf = async (id: string) => (await sql`select kind, duration from attachments where id = ${id}`)[0];
  const song = await createUpload(a, { mime: 'audio/mpeg', name: 'song.mp3', size: 1000, kind: 'audio', duration: 187.4 });
  expect(await kindOf(song.id)).toMatchObject({ kind: 'audio', duration: 187 });
  const noDur = await createUpload(a, { mime: 'audio/mpeg', name: 'song.mp3', size: 1000, kind: 'audio' });
  expect((await kindOf(noDur.id)).kind).toBe('file');
  const notAudio = await createUpload(a, { mime: 'application/pdf', name: 'x.pdf', size: 1000, kind: 'audio', duration: 10 });
  expect((await kindOf(notAudio.id)).kind).toBe('file');
});
