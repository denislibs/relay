import { GIF_MAX_BYTES, SAVED_GIFS_LIMIT, type SavedGif } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { fileKey, openAttachmentRows, openThumb, sealThumb } from '../crypto/fileKeys';
import { enqueue } from '../jobs/queue';
import { DomainError } from './errors';
import { attachmentOf, variantsOf } from './files';
import { groupCtx } from './groupRights';
import { appendUpdates } from './journal';
import { openRows } from './messageContent';
import { dropUnreferenced } from './storageGc';

/**
 * Сохранённые GIF. Строка — только ссылка «пользователь → вложение». Устройство получает ключ файла здесь, развёрнутым из
 * keys.attachment_keys (единственное место, где он хранится вне шифра сообщений); копии ключа, запечатанной долгоживущим
 * ключом пользователя, нет намеренно: она пережила бы удаление и открывалась бы из бэкапа данных весь его срок (30 дней),
 * а docs/SECURITY.md обещает 7.
 *
 * Пока строка есть, файл считается используемым (storageGc.referenced): удаление исходного сообщения его не трогает, это
 * личная копия, как у пересылки. Ушла последняя ссылка — файл и ключ удаляются сразу, не дожидаясь сборки мусора.
 * Из сообщения со сроком сохранить нельзя: файл пережил бы срок на сервере, а срок автоудаления — обещание с конечной датой.
 */

const changed = (tx: Tx, userId: number) => appendUpdates(tx, [{ userId, update: { type: 'myGifs' } }]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Строка saved_gifs + attachments → плитка; open — с именем, ключом и миниатюрой (нужно развернуть ключ файла). */
async function toGif(r: Record<string, unknown>, db: Tx | typeof sql, open: boolean): Promise<SavedGif> {
  const id = r.id as string, savedAt = (r.saved_at as Date).getTime();
  const variants = await variantsOf(db, id);
  if (!open) return { ...attachmentOf({ ...r, name: 'animation.gif' }, null, variants), savedAt };
  await openAttachmentRows([r], db);
  const out: SavedGif = { ...attachmentOf(r, null, variants), savedAt };
  if (Number(r.enc) === 1) {
    const raw = await fileKey(id, db);
    if (raw) {
      out.key = Buffer.from(raw).toString('base64');
      if (r.thumb) out.thumb = await openThumb(userIdOf(r), id, raw, new Uint8Array(r.thumb as Uint8Array));
    }
  }
  return out;
}
const userIdOf = (r: Record<string, unknown>) => Number(r.user_id);

/**
 * Список, новые сверху. have — что устройство уже знает: для этих вложений ключ не разворачивается и миниатюра не открывается.
 * Иначе каждое чтение стоило бы до 200 обращений к KMS (предел — на весь сервер, превышение поднимает тревогу).
 */
export async function listSavedGifs(userId: number, have: unknown): Promise<{ list: SavedGif[] }> {
  const known = new Set(Array.isArray(have) ? have.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, SAVED_GIFS_LIMIT * 2) : []);
  const rows = await sql`select s.user_id, s.thumb, s.saved_at, a.* from saved_gifs s join attachments a on a.id = s.attachment_id
    where s.user_id = ${userId} and a.status = 'ready' order by s.saved_at desc, s.attachment_id limit ${SAVED_GIFS_LIMIT}`;
  return { list: await Promise.all(rows.map((r) => toGif(r, sql, !known.has(r.id as string)))) };
}

/**
 * Сохранить GIF из сообщения. Право проверяется по сообщению: участник чата, видимая ему история, не служебное, не удалённое,
 * чат не защищён от копирования. Повтор поднимает наверх; сверх лимита самая старая вытесняется.
 */
export async function saveGif(userId: number, chatId: number, messageId: number): Promise<{ gif: SavedGif; evicted: string[] }> {
  return sql.begin(async (tx) => {
    const ctx = await groupCtx(tx, chatId, userId);
    if (ctx.protected) throw new DomainError('forbidden', 'protected');
    const [m] = await tx`select * from messages where chat_id = ${chatId} and id = ${messageId} and id >= ${ctx.historyFrom} and not deleted and service_type is null`;
    if (!m) throw new DomainError('not_found', 'message');
    if (m.expires_at) throw new DomainError('forbidden', 'expiring');
    await openRows([m], '', tx);
    const att = m.attachment as { id?: string; kind?: string; mime?: string; thumb?: string | null } | null;
    if (!att?.id || att.kind !== 'photo' || att.mime !== 'image/gif') throw new DomainError('bad_frame', 'not a gif');
    // for share: сборка мусора не удалит файл посреди сохранения (как у пересылки)
    const [a] = await tx`select * from attachments where id = ${att.id} and status = 'ready' for share`;
    if (!a) throw new DomainError('not_found', 'attachment');
    if (Number(a.size) > GIF_MAX_BYTES) throw new DomainError('file_too_big');
    const raw = Number(a.enc) === 1 ? await fileKey(att.id, tx) : null;
    if (Number(a.enc) === 1 && !raw) throw new DomainError('not_found', 'attachment');
    // старые файлы (без шифрования) остаются без миниатюры: ключа, которым её запечатать, у них нет, а открытой она не лежит
    const thumb = raw && att.thumb ? await sealThumb(userId, att.id, raw, att.thumb) : null;
    const [row] = await tx`insert into saved_gifs (user_id, attachment_id, thumb) values (${userId}, ${att.id}, ${thumb})
      on conflict (user_id, attachment_id) do update set saved_at = now(), thumb = coalesce(saved_gifs.thumb, excluded.thumb)
      returning user_id, thumb, saved_at`;
    const evicted = (await tx`delete from saved_gifs where user_id = ${userId} and attachment_id not in (
        select attachment_id from saved_gifs where user_id = ${userId} order by saved_at desc, attachment_id limit ${SAVED_GIFS_LIMIT})
      returning attachment_id`).map((r) => r.attachment_id as string);
    if (evicted.length) await dropUnreferenced(tx, evicted);
    // GIF загружен до появления копии loop: сделать её сейчас (до неё плитка играет оригинал)
    if (a.processed === 'done' && !(await tx`select 1 from attachment_variants where attachment_id = ${att.id} and name = 'loop'`).length) {
      await enqueue(tx, 'photo.process', { id: att.id, redo: true }, { dedupeKey: `photo.redo:${att.id}` });
    }
    await changed(tx, userId);
    return { gif: await toGif({ ...a, ...row }, tx, true), evicted };
  });
}

/** Убрать из сохранённых. Больше никто не ссылается (исходное удалено) — файл и его ключ уходят сразу. Повтор безопасен. */
export async function removeGif(userId: number, attachmentId: string): Promise<{ ok: true }> {
  if (!UUID.test(attachmentId)) throw new DomainError('bad_frame', 'attachment id');
  await sql.begin(async (tx) => {
    const gone = await tx`delete from saved_gifs where user_id = ${userId} and attachment_id = ${attachmentId} returning attachment_id`;
    if (!gone.length) return;
    await dropUnreferenced(tx, [attachmentId]);
    await changed(tx, userId);
  });
  return { ok: true };
}

/** Копия loop появилась (jobs/photo.ts): устройствам тех, кто сохранил, перечитать список. */
export async function gifVariantsChanged(tx: Tx, attachmentId: string): Promise<void> {
  const rows = await tx`select user_id from saved_gifs where attachment_id = ${attachmentId}`;
  if (rows.length) await appendUpdates(tx, rows.map((r) => ({ userId: Number(r.user_id), update: { type: 'myGifs' as const } })));
}
