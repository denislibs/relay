// Ключ чата удалён в любом процессе (триггер keys.notify_chat_key_gone) — забыть его в памяти этого процесса сразу:
// уничтоженный ключ не должен ещё 10 минут открывать сообщения из кэша.
import { sql } from '../db';
import { forgetChat } from './chatKeys';

export async function startKeyEvents(): Promise<() => Promise<void>> {
  const sub = await sql.listen('chat_keys', (payload) => { const id = Number(payload); if (id) forgetChat(id); });
  return () => sub.unlisten();
}
