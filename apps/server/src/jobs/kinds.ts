// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
import { sql } from '../db';
import { deliverPush, planPush, type PushMessage, type PushPayload } from '../domain/push';
import { register } from './handlers';
import { enqueue } from './queue';

// новое сообщение → по задаче на подписку: повтор одной не шлёт остальным второй раз
register('push.message', async (p: { message: PushMessage }) => {
  const targets = await planPush(p.message);
  if (!targets.length) return;
  await sql.begin(async (tx) => {
    for (const t of targets) await enqueue(tx, 'push.deliver', t);
  });
});

register('push.deliver', async (p: { endpoint: string; push: PushPayload }) => {
  await deliverPush(p.endpoint, p.push);
});
