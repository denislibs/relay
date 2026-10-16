// Dev-утилита: действия от имени пользователя прямо через домен (как будто с другого устройства).
//   bun apps/server/src/dev/cli.ts send <userId> <chatId> <text…>
//   bun apps/server/src/dev/cli.ts read <userId> <chatId> [upToId]   — без upToId: до последнего
//   bun apps/server/src/dev/cli.ts users
import { sql } from '../db';
import { sendMessage } from '../domain/messages';
import { markRead } from '../domain/reads';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'send') {
  const [userId, chatId, ...text] = args;
  const { message } = await sendMessage(Number(userId), { chatId: Number(chatId), clientId: crypto.randomUUID(), body: text.join(' ') });
  console.log(JSON.stringify(message));
} else if (cmd === 'read') {
  const [userId, chatId, upTo] = args;
  const upToId = upTo ? Number(upTo) : ((await sql`select coalesce(max(id), 0) as m from messages where chat_id = ${Number(chatId)}`)[0].m as number);
  console.log(JSON.stringify(await markRead(Number(userId), Number(chatId), upToId)));
} else if (cmd === 'users') {
  console.log(JSON.stringify(await sql`select id, name from users order by id`));
} else {
  console.log('usage: send <userId> <chatId> <text> | read <userId> <chatId> [upToId] | users');
}
await sql.end();
