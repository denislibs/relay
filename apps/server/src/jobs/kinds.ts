// Регистрация доменных обработчиков задач. Импортируется процессом-воркером и тестами.
import { sql } from '../db';
import { deliver } from '../domain/devOutbox';
import { sweepPendingUploads } from '../domain/files';
import { collectGarbage, purgeObjects } from '../domain/storageGc';
import { sweepInactive } from '../domain/sessions';
import { deliverPush, planPush, planPushPage, type PushCursor, type PushMessage, type PushPayload } from '../domain/push';
import { reindexStep, syncMessage, syncMessages } from '../search/messagesIndex';
import { register, registerBatch } from './handlers';
import { applyLinkPreview } from '../domain/messages';
import { closeExpired } from '../domain/polls';
import { s3 } from '../domain/files';
import { processVideo } from './video';
import { processPhoto } from './photo';
import { encryptLegacyStep, loadOpen, openForChat, openRows, sealForChat } from '../domain/messageContent';
import { rewrapStep } from '../crypto/kms';
import { toMessage } from '../domain/chats';
import { enqueue, type Job } from './queue';
import { purgeStep, type PurgeJob } from '../domain/chatPurge';
import { flushReactionCounts } from '../domain/reactionCounts';
import { flushReplies } from '../domain/threads';

/** Подписок на страницу push.message (тесты уменьшают). */
export const PUSH_PAGE = { size: 1000 };

/** Аренду страницы push.message перехватил другой воркер (истекла): транзакция страницы откатывается целиком. */
class LeaseLost extends Error {}

// новое сообщение → по задаче на подписку: повтор одной не шлёт остальным второй раз
// в задаче — ссылка на сообщение (новые) или само сообщение (поставленные до шифрования)
// страницами по PUSH_PAGE.size подписок: канал на 200 000 с 2000 подписками — две страницы. Страница — одна транзакция:
// доставки (dedupe по endpoint и сообщению), продолжение со своим курсором и удаление самой задачи; строку задачи
// уже удалил другой воркер (аренда истекла и перехвачена) — откат, ничего не вставлено. Либо всё, либо ничего
register('push.message', async (p: { chatId?: number; id?: number; groupId?: string; message?: PushMessage; after?: PushCursor }, job: Job) => {
  let m = p.message;
  let excludeChatId: number | undefined;
  if (!m && p.chatId != null && p.id != null && p.groupId) {
    // альбом: одно уведомление на все файлы — по первому сообщению, подпись берётся у того, где она есть
    const rows = await openRows(await sql`select * from messages where chat_id = ${p.chatId} and group_id = ${p.groupId} and not deleted order by id`);
    if (!rows.length) return;
    const captioned = rows.find((r) => (r.body as string)) ?? rows[0];
    m = { ...toMessage(rows[0]), body: captioned.body as string, entities: (captioned.entities as PushMessage['entities']) ?? undefined, senderId: Number(rows[0].sender_id), album: rows.length } as PushMessage;
    const origin = rows[0].origin as { chatId?: unknown } | null;
    if (origin?.chatId != null) excludeChatId = Number(origin.chatId);
  }
  if (!m && p.chatId != null && p.id != null) {
    const row = await loadOpen(p.chatId, p.id);
    if (!row || row.deleted) return;   // удалили, пока задача ждала
    // автор — внутренний sender_id строки: у поста канала в API senderId 0, а исключить автора и блокировки нужно по нему
    m = { ...toMessage(row), senderId: Number(row.sender_id) } as PushMessage;
    // копия поста в группе обсуждения: подписчики канала уже получили push о самом посте — им второго не шлём
    const origin = row.origin as { chatId?: unknown } | null;
    if (origin?.chatId != null) excludeChatId = Number(origin.chatId);
  }
  if (!m) return;
  const page = await planPushPage(m, { excludeChatId, after: p.after, limit: PUSH_PAGE.size });
  // текст уведомления — запечатан ключом чата: в jobs/jobs_dead не лежит открытым
  const sealed = await Promise.all(page.targets.map(async (t) => ({ endpoint: t.endpoint, chatId: t.push.chatId, sealed: await sealForChat(t.push.chatId, t.push, 'jobs|push') })));
  const next = page.full && page.last ? page.last : null;
  if (!sealed.length && !next) return;
  let delivered = 0;
  await sql.begin(async (tx) => {
    if (sealed.length) {
      const ins = await tx`
        insert into jobs (kind, payload, run_at, dedupe_key, max_attempts)
        select 'push.deliver', d.p::jsonb, now(), d.k, 8
          from unnest(${sealed.map((s) => JSON.stringify(s))}::text[], ${sealed.map((s) => `push.deliver:${s.endpoint}:${m.id}`)}::text[]) as d(p, k)
        on conflict (dedupe_key) where dedupe_key is not null do nothing
        returning id`;
      delivered = ins.length;
    }
    if (next) await enqueue(tx, 'push.message', { ...p, after: next }, { dedupeKey: `push.message:${m.chatId}:${m.id}:${next[0]}:${next[1]}` });
    // строка задачи — та, что мы арендовали: иначе её уже ведёт другой воркер (и вставит то же сам)
    if (job?.id != null) {
      const gone = await tx`delete from jobs where id = ${job.id} and attempts = ${job.attempts} returning id`;
      if (!gone.length) throw new LeaseLost(`push.message ${job.id}: lease taken over`);
    }
  });
  // массовая вставка — мимо enqueue: будим воркеры сами, только после коммита (при откате сюда не дойдём)
  if (delivered) await sql`select pg_notify('jobs', 'push.deliver')`;
  // строка уже удалена в транзакции: complete воркера (delete … and attempts) ничего не найдёт и не бросит
});

// упоминание (mentions.ts): одному адресату, сквозь mute; строки упоминания уже нет (прочитал, удалили) — молчим
register('push.mention', async (p: { chatId: number; id: number; userId: number }) => {
  const [still] = await sql`select 1 from message_mentions where user_id = ${p.userId} and chat_id = ${p.chatId} and message_id = ${p.id}`;
  if (!still) return;
  const row = await loadOpen(p.chatId, p.id);
  if (!row || row.deleted) return;
  const m = { ...toMessage(row), senderId: Number(row.sender_id) } as PushMessage;
  const targets = await planPush(m, { mentionOf: Number(p.userId) });
  if (!targets.length) return;
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
// уничтоженная история (shred.ts) или удалённая группа: её документы — из индекса поиска (CRYPTO-1)
register('search.purgeChat', async (p: { chatId: number; below: number | null }) => {
  const { purgeChatIndex } = await import('../search/messagesIndex');
  await purgeChatIndex(Number(p.chatId), p.below == null ? null : Number(p.below));
});
// срок хранения журнала пользователя (CRYPTO-3): записи старше JOURNAL_DAYS удаляются пачками; отставший сильнее
// клиент получит tooLong и заберёт снимок заново (getUpdates). Раз в сутки
export const JOURNAL_DAYS = Number(process.env.JOURNAL_DAYS) || 30;
register('journal.trim', async () => {
  for (;;) {
    const r = await sql`delete from updates where ctid in (select ctid from updates where created_at < now() - make_interval(days => ${JOURNAL_DAYS}) limit 5000)`;
    if (r.count < 5000) break;
  }
  return { again: { inSec: 24 * 3600 } };
});
register('attachment.purge', async (p: { keys: string[] }) => {
  await purgeObjects(p.keys);
});

// мягко удалённый канал или группа: участники (chatRemoved каждому), сообщения и сам чат — страницами (chatPurge.ts)
register('chat.purge', async (p: PurgeJob) => {
  await purgeStep(p);
});

// комментарии к посту: счётчики треда одним событием replies на секундное окно (threads.ts)
register('replies.flush', async (p: { chatId: number; postId: number }) => {
  await flushReplies(p);
});

// реакции поста канала: счётчики одним событием reactionCounts на секундное окно (reactionCounts.ts)
register('reactions.flush', async (p: { chatId: number; id: number }) => {
  await flushReactionCounts(p);
});

register('poll.close', async (p: { chatId: number; id: number }) => {
  await closeExpired(p.chatId, p.id);
});

register('link.preview', async (p: { chatId: number; id: number; url?: string }) => {
  await applyLinkPreview(p);
});
// срок кэша превью ссылок (CRYPTO-4): раз в сутки
register('linkPreview.expire', async () => {
  const { expirePreviews } = await import('../domain/linkPreview');
  await expirePreviews();
  return { again: { inSec: 24 * 3600 } };
});
