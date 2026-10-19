import { beforeEach, expect, test } from 'bun:test';
import { MEDIA_TABS, mediaTabs } from '@relay/protocol';
import { sql } from '../src/db';
import { tabWhere, toMessage } from '../src/domain/chats';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

// Правило вкладки одно на сервер (tabWhere) и клиент (mediaTabs): состав каждой вкладки обязан совпадать.
test('tabWhere and protocol mediaTabs select the same messages for every tab', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  const att = (kind: string, mime: string | null) => ({ id: crypto.randomUUID(), kind, mime, name: 'x', size: 1, w: null, h: null });
  const link = [{ type: 'link', offset: 0, length: 3, url: 'https://x.y' }];
  const bold = [{ type: 'bold', offset: 0, length: 3 }];
  const cases: [string, string, object | null, object | null, string | null][] = [
    ['photo', '', att('photo', 'image/png'), null, null],
    ['photo', 'см. https://a.b', att('photo', 'image/png'), null, null],
    ['video', '', att('video', 'video/mp4'), null, null],
    ['file', '', att('file', 'video/mp4'), null, null],
    ['file', 'тут www.a.b', att('file', 'video/webm'), null, null],
    ['file', '', att('file', 'application/pdf'), null, null],
    ['file', 'док', att('file', 'application/pdf'), link, null],
    ['file', '', att('file', null), null, null],
    ['audio', '', att('audio', 'audio/mpeg'), null, null],
    ['voice', '', att('voice', 'audio/ogg'), null, null],
    ['round', '', att('round', 'video/mp4'), null, null],
    ['text', 'смотри https://example.com', null, null, null],
    ['text', 'HTTP://UP.CASE/x', null, null, null],
    ['text', 'тут', null, link, null],
    ['text', 'жирно', null, bold, null],
    ['text', 'без ссылок', null, null, null],
    ['text', 'www', null, null, null],
    ['text', 'https:// пусто', null, null, null],
    ['text', 'Код https://relay.app', null, null, 'login_code'],
    ['text', 'ссылка', null, link, 'welcome'],
  ];
  const ids: number[] = [];
  for (const [kind, body, attachment, entities, service] of cases) {
    const [r] = await sql`insert into messages (chat_id, sender_id, client_id, kind, body, attachment, entities, service_type)
      values (${chat}, ${a}, ${crypto.randomUUID()}, ${kind}, ${body}, ${attachment ? sql.json(attachment as never) : null}, ${entities ? sql.json(entities as never) : null}, ${service}) returning id`;
    ids.push(Number(r.id));
  }
  const rows = await sql`select * from messages where chat_id = ${chat} order by id`;
  const msgs = rows.map(toMessage);
  expect(msgs.length).toBe(cases.length);
  for (const tab of MEDIA_TABS) {
    const server = (await sql`select id from messages where chat_id = ${chat} and ${tabWhere(tab)} order by id`).map((r) => Number(r.id));
    const client = msgs.filter((m) => mediaTabs(m).includes(tab)).map((m) => m.id);
    expect(client).toEqual(server);
    expect(server.length).toBeGreaterThan(0);
  }
});
