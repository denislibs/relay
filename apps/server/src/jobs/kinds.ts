// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
import { sql } from '../db';
import { deliver } from '../domain/devOutbox';
import { sweepPendingUploads } from '../domain/files';
import { sweepInactive } from '../domain/sessions';
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

// письмо восстановления пароля: код лежит в payload.secret до выполнения задачи
register('mail.recovery', async (p: { to: string; secret: { code: string } }) => {
  await deliver({ to: p.to, kind: 'recovery', code: p.secret.code });
});

export const SWEEP_EVERY_SEC = 3600;

// автозавершение истёкших и неактивных сеансов; NOTIFY sessions закроет их сокеты в процессах сервера
register('sessions.sweep', async () => {
  await sweepInactive();
  return { again: { inSec: SWEEP_EVERY_SEC } };
});

// брошенные загрузки (pending старше суток): запись и объект в S3
register('uploads.sweep', async () => {
  await sweepPendingUploads();
  return { again: { inSec: SWEEP_EVERY_SEC } };
});
