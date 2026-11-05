import { beforeEach, expect, test } from 'bun:test';
import { sql } from '../src/db';
import { setChatTheme } from '../src/domain/chatTheme';
import { createGroup, listChats } from '../src/domain/chats';
import { postService, welcomeMessage } from '../src/domain/service';
import { THEMES } from '../src/domain/themes';
import { chatEventsOf, journalOf, makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('the catalog: every theme has all four bases with a 6-digit accent and 4 wallpaper colors', () => {
  expect(THEMES.length).toBeGreaterThan(4);
  for (const t of THEMES) for (const b of ['classic', 'day', 'night', 'tinted'] as const) {
    expect(t.settings[b].accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.settings[b].wallpaper?.colors).toHaveLength(4);
  }
});

test('a direct chat: either side sets the theme; both get the service message and chatTheme; the list carries it', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const chat = await makeChat([a, b]);
  await setChatTheme(b, chat, 'chick');
  for (const u of [a, b]) {
    expect(await journalOf(u, 'chatTheme')).toEqual([{ type: 'chatTheme', chatId: chat, theme: 'chick' }]);
    const msg = (await journalOf(u, 'newMessage')).map((x) => (x as { message: { service?: unknown; senderId: number } }).message).find((m) => m.service);
    expect(msg).toMatchObject({ senderId: b, service: { type: 'theme_changed', data: { emoji: '🐥', title: 'Цыплёнок' } } });
    expect((await listChats(u)).find((c) => c.id === chat)?.theme).toBe('chick');
  }
  // та же тема — ничего не пишется; снять — служебное без эмодзи
  await setChatTheme(a, chat, 'chick');
  expect(await journalOf(a, 'chatTheme')).toHaveLength(1);
  await setChatTheme(a, chat, null);
  expect((await journalOf(b, 'chatTheme')).at(-1)).toEqual({ type: 'chatTheme', chatId: chat, theme: null });
  const [last] = await sql`select service_type, service_data from messages where chat_id = ${chat} order by id desc limit 1`;
  expect([last.service_type, last.service_data]).toEqual(['theme_changed', null]);
});

test('unknown theme, a stranger, the service chat, a blocked peer, a channel subscriber — refused', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис'), s = await makeUser('Чужой');
  const chat = await makeChat([a, b]);
  await expect(setChatTheme(a, chat, 'neon')).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(setChatTheme(a, chat, 5)).rejects.toMatchObject({ code: 'bad_frame' });
  await expect(setChatTheme(s, chat, 'chick')).rejects.toMatchObject({ code: 'not_member' });
  // служебный чат напрямую: ensureServiceChat помнит id с прошлых тестов (после очистки базы id начинаются заново)
  await sql.begin((tx) => postService(tx, a, { type: 'welcome', ...welcomeMessage() }, { push: false }));
  const [svc] = await sql`select c.id from chats c join chat_members m on m.chat_id = c.id join users u on u.id = m.user_id where u.system and c.kind = 'direct' and exists (select 1 from chat_members x where x.chat_id = c.id and x.user_id = ${a})`;
  await expect(setChatTheme(a, Number(svc.id), 'chick')).rejects.toMatchObject({ code: 'forbidden' });
  await sql`insert into blocks (owner_id, user_id) values (${b}, ${a})`;
  await expect(setChatTheme(a, chat, 'snow')).rejects.toMatchObject({ code: 'blocked' });
  const c = await makeUser('Вера');   // с Борисом блокировка: в канал его не добавить
  const { chatId: ch } = await createGroup(a, { kind: 'channel', title: 'Новости', memberIds: [c] });
  await expect(setChatTheme(c, ch, 'snow')).rejects.toMatchObject({ code: 'forbidden' });
  await setChatTheme(a, ch, 'snow');   // владелец — может; в канале — одной записью в журнале чата
  expect(await chatEventsOf(ch, 'chatTheme')).toEqual([{ type: 'chatTheme', chatId: ch, theme: 'snow' }]);
});
