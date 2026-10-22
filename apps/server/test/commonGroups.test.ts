import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { commonGroups } from '../src/domain/chats';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('common groups: only groups with both people, newest activity first, member count; not directs, not self', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), c = await makeUser('Вера');
  const old = await makeChat([a, b, c], 'group');
  const fresh = await makeChat([a, b], 'group');
  await makeChat([a, c], 'group');          // без Бориса
  await makeChat([a, b]);                   // личный — не группа
  await sql`update chats set title = 'Старая' where id = ${old}`;
  await sql`update chats set title = 'Свежая' where id = ${fresh}`;
  await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${old}, ${a}, ${crypto.randomUUID()}, 'text', 'раз')`;
  await sql`insert into messages (chat_id, sender_id, client_id, kind, body) values (${fresh}, ${b}, ${crypto.randomUUID()}, 'text', 'два')`;

  expect(await commonGroups(a, b)).toEqual([
    { id: fresh, title: 'Свежая', photo: null, members: 2 },
    { id: old, title: 'Старая', photo: null, members: 3 },
  ]);
  expect((await commonGroups(b, a)).map((g) => g.id)).toEqual([fresh, old]);
  expect(await commonGroups(a, a)).toEqual([]);
  expect((await commonGroups(b, c)).map((g) => g.id)).toEqual([old]);
});
