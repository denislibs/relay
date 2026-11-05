// Аудит 2026-10-25, CRYPTO-3: старые записи журнала с открытым текстом переписываются в ссылки; журнал имеет срок.
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../src/db';
import { sendMessage } from '../src/domain/messages';
import { getUpdates } from '../src/domain/journal';
import { makeChat, makeUser, resetDb } from './helpers';

beforeEach(resetDb);

test('CRYPTO-3: a legacy plaintext journal entry becomes a reference; the client still gets the full message', async () => {
  const a = await makeUser('a'), b = await makeUser('b');
  const chat = await makeChat([a, b]);
  const { message } = await sendMessage(a, { chatId: chat, clientId: crypto.randomUUID(), body: 'старый открытый текст' });
  // как писал журнал до шифрования: событие целиком
  await sql`update updates set payload = ${sql.json({ type: 'newMessage', message } as never)} where user_id = ${b} and type = 'newMessage'`;
  await sql`insert into updates (user_id, seq, type, payload) values (${b}, 1000, 'draft', ${sql.json({ type: 'draft', chatId: chat, text: 'черновик открыто', at: new Date().toISOString() } as never)})`;
  expect(JSON.stringify(await sql`select payload from updates where user_id = ${b}`)).toContain('старый открытый текст');
  await sql.unsafe(readFileSync(join(import.meta.dir, '../migrations/157_journal_refs.sql'), 'utf8'));
  const raw = JSON.stringify(await sql`select payload from updates where user_id = ${b}`);
  expect(raw).not.toContain('старый открытый текст');
  expect(raw).not.toContain('черновик открыто');
  const items = (await getUpdates(b, 0)).items.map((i) => i.update);
  expect(items.find((u) => u.type === 'newMessage')).toMatchObject({ message: { id: message.id, body: 'старый открытый текст' } });
});
