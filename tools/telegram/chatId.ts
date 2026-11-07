/**
 * Узнать id личного чата владельца с ботом (TELEGRAM_OWNER_CHAT_ID, docs/code-delivery.md).
 * Сначала напишите боту /start из своего аккаунта Telegram, потом:
 *
 *   TELEGRAM_BOT_TOKEN=… bun tools/telegram/chatId.ts
 *
 * Читает getUpdates (у бота не должно быть webhook) и печатает отправителей личных сообщений. Токен не печатается.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
const api = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
type Update = { message?: { chat: { id: number; type: string; username?: string; first_name?: string }; text?: string } };
const res = await fetch(`${api}/bot${token}/getUpdates`).catch(() => null);
const body = (await res?.json().catch(() => null)) as { ok?: boolean; description?: string; result?: Update[] } | null;
if (!body?.ok) {
  console.error(`getUpdates failed: ${res?.status ?? 'network error'} ${body?.description ?? ''}`);
  process.exit(1);
}
const chats = new Map<number, string>();
for (const u of body.result ?? []) {
  const c = u.message?.chat;
  if (c?.type === 'private') chats.set(c.id, [c.first_name, c.username && '@' + c.username].filter(Boolean).join(' '));
}
if (!chats.size) {
  console.log('Личных сообщений нет: напишите боту /start и запустите ещё раз.');
} else {
  for (const [id, who] of chats) console.log(`TELEGRAM_OWNER_CHAT_ID=${id}   # ${who}`);
}

export {};
