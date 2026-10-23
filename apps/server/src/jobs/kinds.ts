// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
import { sql } from '../db';
import { deliver } from '../domain/devOutbox';
import { sweepPendingUploads } from '../domain/files';
import { collectGarbage, purgeObjects } from '../domain/storageGc';
import { sweepInactive } from '../domain/sessions';
import { deliverPush, planPush, type PushMessage, type PushPayload } from '../domain/push';
import { reindexStep, syncMessage, syncMessages } from '../search/messagesIndex';
import { register, registerBatch } from './handlers';
import { applyLinkPreview } from '../domain/messages';
import { s3 } from '../domain/files';
import { processVideo } from './video';
import { processPhoto } from './photo';
import { encryptLegacyStep, loadOpen, openForChat, sealForChat } from '../domain/messageContent';
import { rewrapStep } from '../crypto/kms';
import { toMessage } from '../domain/chats';
import { enqueue } from './queue';

// новое сообщение → по задаче на подписку: повтор одной не шлёт остальным второй раз
// в задаче — ссылка на сообщение (новые) или само сообщение (поставленные до шифрования)
register('push.message', async (p: { chatId?: number; id?: number; message?: PushMessage }) => {
  let m = p.message;
  if (!m && p.chatId != null && p.id != null) {
    const row = await loadOpen(p.chatId, p.id);
    if (!row || row.deleted) return;   // удалили, пока задача ждала
    m = toMessage(row) as PushMessage;
  }
  if (!m) return;
  const targets = await planPush(m);
  if (!targets.length) return;
  // текст уведомления — запечатан ключом чата: в jobs/jobs_dead не лежит открытым
  const sealed = await Promise.all(targets.map(async (t) => ({ endpoint: t.endpoint, chatId: t.push.chatId, sealed: await sealForChat(t.push.chatId, t.push, 'jobs|push') })));
  await sql.begin(async (tx) => {
    for (const t of sealed) await enqueue(tx, 'push.deliver', t);
  });
});

register('push.deliver', async (p: { endpoint: string; push?: PushPayload; chatId?: number; sealed?: string }) => {
  const push = p.push ?? (p.sealed && p.chatId != null ? await openForChat<PushPayload>(p.chatId, p.sealed, 'jobs|push').catch(() => null) : null);
  if (!push) return;   // чат удалён — ключа нет, слать нечего
  await deliverPush(p.endpoint, push);
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

// сообщение создано, изменено или удалено: привести индекс к текущей строке (идемпотентно)
// под нагрузкой — пачкой: одно чтение строк и один запрос в Meilisearch на индекс вместо пары на сообщение
register('search.sync', async (p: { id: number }) => {
  await syncMessage(p.id);
});
registerBatch('search.sync', (jobs) => syncMessages(jobs.map((j) => Number(j.payload.id))), { max: 200 });

// полная перестройка индекса поиска рядом с живым (воркер при старте, dev-seed): короткими шагами, каждый
// укладывается в аренду; не закончили — та же задача сразу снова в очередь и продолжит с курсора
register('search.reindex', async (p: { batch?: number; maxBatches?: number }) => {
  const r = await reindexStep({ batch: p.batch, maxBatches: p.maxBatches });
  console.log(`search: reindex +${r.copied}${r.done ? ', done' : ''}`);
  if (!r.done) return { again: { inSec: 0 } };
});

// старые строки (до шифрования): шифруем пачками по курсору; закончили — задача не возвращается
register('crypto.encrypt', async (p: { after?: number; batch?: number }) => {
  const r = await encryptLegacyStep(p.after ?? 0, p.batch ?? 500);
  if (r.encrypted) console.log(`crypto: encrypted +${r.encrypted}${r.done ? ', done' : ''}`);
  if (!r.done) await enqueue(sql, 'crypto.encrypt', { after: r.next, batch: p.batch });
});

// смена главного ключа: ключи чатов перезаворачиваются новым (данные не перешифровываются); раз в сутки и при старте
register('crypto.rewrap', async (p: { after?: [number, number] }) => {
  const r = await rewrapStep(sql, p.after ?? [0, 0]);
  if (r.rewrapped) console.log(`crypto: rewrapped ${r.rewrapped} chat keys`);
  if (!r.done) { await enqueue(sql, 'crypto.rewrap', { after: r.next }); return; }
  return { again: { inSec: 24 * 3600 } };
});

// брошенные загрузки (pending старше суток): запись и объект в S3
register('uploads.sweep', async () => {
  await sweepPendingUploads();
  return { again: { inSec: SWEEP_EVERY_SEC } };
});

/** Задачи с ffmpeg — каждая своим циклом воркера с малым параллелизмом (worker.ts): не задерживают push и поиск. */
export const SLOW_KINDS = { video: ['video.process'], photo: ['photo.process'] };

// превью ссылки: страница грузится вне отправки — сообщение уже в ленте, превью дорисуется
// видео-медиа после загрузки: faststart, ролик для ленты, 720p (jobs/video.ts); отдельный цикл воркера с малым параллелизмом
register('video.process', async (p: { id: string }) => {
  await processVideo(p);
});

// фото и картинка-файл после загрузки: уменьшенная копия для сетки «Медиа» (jobs/photo.ts); свой цикл воркера
register('photo.process', async (p: { id: string }) => {
  await processPhoto(p);
});

// объект хранилища, на который больше никто не ссылается (старый оригинал после перепаковки)
register('storage.delete', async (p: { key: string }) => {
  await s3().delete(p.key);
});

// мусор в хранилище (domain/storageGc.ts): несколько пачек за запуск; не дошли до конца — продолжить сразу
register('storage.gc', async () => {
  const r = await collectGarbage();
  if (r.deleted) console.log(`storage gc: -${r.deleted} of ${r.scanned}`);
  return { again: { inSec: r.done ? SWEEP_EVERY_SEC : 0 } };
});

// объекты удалённого сборкой мусора вложения: оригинал, перепакованный оригинал, копии видео (удаление идемпотентно)
register('attachment.purge', async (p: { keys: string[] }) => {
  await purgeObjects(p.keys);
});

register('link.preview', async (p: { chatId: number; id: number; url: string }) => {
  await applyLinkPreview(p);
});
