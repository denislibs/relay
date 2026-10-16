import { sql } from '../src/db';

export async function resetDb(): Promise<void> {
  await sql`truncate users, sessions, chats, chat_members, messages, user_seq, updates restart identity cascade`;
}

export async function makeUser(name = 'user'): Promise<number> {
  const [row] = await sql`insert into users (name) values (${name}) returning id`;
  return row.id as number;
}

import { createChat } from '../src/domain/chats';

export function makeChat(memberIds: number[], kind: 'direct' | 'group' = memberIds.length > 2 ? 'group' : 'direct'): Promise<number> {
  return createChat(kind, kind === 'group' ? 'Группа' : null, memberIds);
}

import type { ServerFrame } from '@relay/protocol';

/** Ждёт первый кадр, удовлетворяющий условию. */
export function nextFrame(ws: WebSocket, match: (f: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error('timeout waiting for frame')); }, timeoutMs);
    function on(e: MessageEvent) {
      const f = JSON.parse(String(e.data)) as ServerFrame;
      if (match(f)) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(f); }
    }
    ws.addEventListener('message', on);
  });
}
