import { sql } from '../src/db';

export async function resetDb(): Promise<void> {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}
