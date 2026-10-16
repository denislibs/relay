import { sql } from '../src/db';

export async function resetDb(): Promise<void> {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}

export async function makeUser(name = 'user'): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name}) returning id`;
  return row.id as number;
}
