import { sql } from '../db';
import { enqueue } from '../jobs/queue';
import { s3 } from './files';

/**
 * Сборка мусора в хранилище: готовое вложение, на которое больше ничто не ссылается, удаляется вместе с объектами в S3.
 * «Ссылается» — ровно то, что даёт доступ к файлу в fileFor (кроме владельца): не удалённое сообщение (пересылки
 * хранят тот же id — пока жива хоть одна копия, файл жив), музыка профиля, фото профиля (история и текущее),
 * фото группы, картинка превью ссылки. Файл, который никто, кроме владельца, открыть не может, — мусор.
 * Отсрочка grace: только что загруженное ещё не успели отправить (очередь клиента, офлайн) — его не трогаем.
 *
 * Обход — курсором по (created_at, id) пачками, курсор в server_meta: таблица может быть большой, один запуск
 * проходит несколько пачек и продолжает следующим. Гонка с пересылкой: строка-кандидат берётся for update skip locked,
 * ссылки перепроверяются отдельным запросом (свежий снимок); пересылка держит строку for share (messages.ts) —
 * значит, или GC её пропустит, или пересылка увидит, что вложения уже нет.
 * Объекты удаляет задача attachment.purge (повторы при сбое S3), запись — сразу в той же транзакции.
 */
const DAY = 24 * 3600_000;
export const gcGraceMs = (): number => {
  const d = Number(process.env.UPLOAD_GC_GRACE_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : 7) * DAY;
};
const CURSOR = 'storage_gc_cursor';

/** Условие «на вложение a кто-то ссылается» (тот же набор, что в fileFor). */
const referenced = (db: typeof sql) => db`(
     exists (select 1 from messages m where m.attachment->>'id' = a.id::text and not m.deleted)
  or exists (select 1 from profile_music pm where pm.attachment_id = a.id)
  or exists (select 1 from user_photos up where up.big = a.id or up.small = a.id or up.video = a.id)
  or exists (select 1 from users u where u.photo is not null and (u.photo->>'id' = a.id::text or u.photo->>'small' = a.id::text))
  or exists (select 1 from chat_photos cp where cp.big = a.id or cp.small = a.id)
  or exists (select 1 from link_previews lp where lp.photo_id = a.id))`;

export interface GcResult { scanned: number; deleted: number; done: boolean }

/** Несколько пачек обхода. done — дошли до конца (курсор сброшен, следующий запуск начнёт сначала). */
export async function collectGarbage(opts: { graceMs?: number; batch?: number; maxBatches?: number } = {}): Promise<GcResult> {
  const grace = (opts.graceMs ?? gcGraceMs()) / 1000, batch = opts.batch ?? 500, maxBatches = opts.maxBatches ?? 20;
  const out: GcResult = { scanned: 0, deleted: 0, done: false };
  for (let i = 0; i < maxBatches && !out.done; i++) {
    await sql.begin(async (tx) => {
      const [cur] = await tx`select v from server_meta where k = ${CURSOR}`;
      const [at, id] = cur ? (cur.v as string).split('|') : ['-infinity', '00000000-0000-0000-0000-000000000000'];
      const rows = await tx`
        select a.id, a.created_at::text as at, not ${referenced(tx as never)} as garbage from attachments a
         where a.status = 'ready' and a.created_at < now() - ${grace} * interval '1 second'
           and (a.created_at, a.id) > (${at}::text::timestamptz, ${id}::text::uuid)
         order by a.created_at, a.id limit ${batch}`;
      out.scanned += rows.length;
      const candidates = rows.filter((r) => r.garbage).map((r) => r.id as string);
      if (candidates.length) {
        const locked = (await tx`select id from attachments where id = any(${candidates}::uuid[]) for update skip locked`).map((r) => r.id as string);
        if (locked.length) {
          const variants = await tx`select attachment_id, key from attachment_variants where attachment_id = any(${locked}::uuid[])`;
          const gone = await tx`delete from attachments a where a.id = any(${locked}::uuid[]) and not ${referenced(tx as never)} returning a.id, a.storage_key`;
          const keys = new Set<string>();
          const ids = new Set(gone.map((g) => g.id as string));
          for (const g of gone) { keys.add(g.id as string); if (g.storage_key) keys.add(g.storage_key as string); }
          for (const v of variants) if (ids.has(v.attachment_id as string)) keys.add(v.key as string);
          if (keys.size) await enqueue(tx, 'attachment.purge', { keys: [...keys] });
          out.deleted += gone.length;
        }
      }
      if (rows.length < batch) {
        out.done = true;
        await tx`delete from server_meta where k = ${CURSOR}`;
      } else {
        const last = rows[rows.length - 1];
        const v = `${last.at as string}|${last.id as string}`;   // текстом: микросекунды Date бы потерял
        await tx`insert into server_meta (k, v) values (${CURSOR}, ${v}) on conflict (k) do update set v = excluded.v`;
      }
    });
  }
  return out;
}

/** Объекты удалённых вложений (задача attachment.purge). Отсутствующий ключ S3 удаляет без ошибки — повтор безопасен. */
export async function purgeObjects(keys: string[]): Promise<void> {
  for (const k of keys) await s3().delete(k);
}
