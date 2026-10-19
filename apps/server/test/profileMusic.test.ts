import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { addProfileMusic, listProfileMusic, removeProfileMusic } from '../src/domain/profileMusic';
import { fileFor } from '../src/domain/files';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

async function song(chatId: number, sender: number, name = 'Мы Сверхновая.mp3') {
  const [a] = await sql`insert into attachments (owner_id, mime, name, size, kind, duration) values (${sender}, 'audio/mpeg', ${name}, 1000, 'audio', 170) returning id`;
  const att = { id: a.id, kind: 'audio', mime: 'audio/mpeg', name, size: 1000, w: null, h: null, duration: 170 };
  const [m] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment) values (${chatId}, ${sender}, ${crypto.randomUUID()}, 'audio', '', ${sql.json(att as never)}) returning id`;
  return { msg: Number(m.id), att: a.id as string };
}

test('add a track from a chat to the profile; strangers see it and can play the file; blocked users cannot', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера'), d = await makeUser('Глеб');
  const chat = await makeChat([a, b]);
  const t = await song(chat, b);
  expect(await fileFor(c, t.att)).toBeNull();                     // пока трек только в чате — чужим нельзя
  const mine = await addProfileMusic(a, chat, t.msg);
  expect(mine).toMatchObject([{ id: t.att, title: 'Мы Сверхновая', duration: 170, mime: 'audio/mpeg' }]);
  await addProfileMusic(a, chat, t.msg);                            // повтор — без дубля
  expect((await listProfileMusic(c, a)).map((x) => x.id)).toEqual([t.att]);
  expect(await fileFor(c, t.att)).not.toBeNull();                 // в профиле — слушать может любой
  await sql`insert into blocks (owner_id, user_id) values (${a}, ${d})`;
  expect(await listProfileMusic(d, a)).toEqual([]);
  expect(await fileFor(d, t.att)).toBeNull();
  expect(await removeProfileMusic(a, t.att)).toEqual([]);
  expect(await fileFor(c, t.att)).toBeNull();
});

test('only music from a chat you are in', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]);
  const t = await song(chat, b);
  await expect(addProfileMusic(c, chat, t.msg)).rejects.toMatchObject({ code: 'not_member' });
  const [txt] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${chat}, ${a}, ${crypto.randomUUID()}, 'text', 'hi') returning id`;
  await expect(addProfileMusic(a, chat, Number(txt.id))).rejects.toMatchObject({ code: 'not_found' });
});

test('profile music changes reach everyone who sees the user as userUpdated with the summary', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const chat = await makeChat([a, b]);
  const t1 = await song(chat, b), t2 = await song(chat, b, 'Плачу в код.mp3');
  const music = async (to: number) => {
    const rows = await sql`select payload from updates where user_id = ${to} and type = 'userUpdated' order by seq`;
    return rows.map((r) => (r.payload as { user: { id: number; music?: unknown } }).user).filter((u) => u.id === a).map((u) => u.music ?? null);
  };
  await addProfileMusic(a, chat, t1.msg);
  await addProfileMusic(a, chat, t2.msg);
  await addProfileMusic(a, chat, t2.msg);   // повтор ничего не меняет — записи нет
  expect(await music(b)).toEqual([
    { count: 1, top: { id: t1.att, title: 'Мы Сверхновая', duration: 170 } },
    { count: 2, top: { id: t2.att, title: 'Плачу в код', duration: 170 } },
  ]);
  expect((await music(a)).length).toBe(2);   // себе — тоже (другие устройства)
  expect(await music(c)).toEqual([]);        // общего чата нет — не зритель
  await removeProfileMusic(a, t2.att);
  await removeProfileMusic(a, t1.att);
  expect((await music(b)).slice(2)).toEqual([{ count: 1, top: { id: t1.att, title: 'Мы Сверхновая', duration: 170 } }, null]);
});
