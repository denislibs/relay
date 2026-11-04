import { AUTO_DELETE_DEV_MIN_SEC, AUTO_DELETE_MAX_SEC, AUTO_DELETE_MIN_SEC } from '@relay/protocol';
import { sql } from '../db';
import { DomainError } from './errors';
import { groupCtx, hasAdmin, isCommunity } from './groupRights';
import { serviceMessage } from './groups';
import { chatEvent } from './journal';
import { erase } from './messageOps';
import { blockedInDirect } from './privacy';
import { dropUnreferenced } from './storageGc';
import { recountThread, withCopy } from './threads';

/**
 * Автоудаление сообщений чата. Настройка — chats.auto_delete_sec; срок сообщения (messages.expires_at) ставит sendMessage из
 * настройки на момент публикации и больше не двигает. Выключение и смена срока уже отправленных не касаются (как в Telegram).
 *
 * Три слоя, чтобы вышедшее было недоступно на деле:
 *  1. чтение: запросы отсекают expires_at <= now(), openRows считает такую строку удалённой — даже если задача не дошла;
 *  2. задача messages.expire: стирает строку тем же erase, что «удалить для всех» (журнал, реакции, закрепы, поиск), вложение
 *     без других ссылок — сразу, вместе с ключом файла;
 *  3. срочный ключ (crypto/chatKeys.ts): сообщение со сроком зашифровано ключом суточной корзины срока, ключ уничтожается,
 *     когда корзина прошла и живых сообщений в ней нет. Старый шифр в бэкапе данных больше не открыть, ключи в бэкапе — 7 дней.
 */

/** Нижняя граница срока: час. Под DEV_LOGIN — секунды, чтобы проверять руками; production с DEV_LOGIN не стартует (tls.ts). */
const minSec = (): number => (process.env.DEV_LOGIN === '1' ? AUTO_DELETE_DEV_MIN_SEC : AUTO_DELETE_MIN_SEC);

export function validSec(raw: unknown): number | null {
  if (raw === null) return null;
  if (!Number.isSafeInteger(raw) || (raw as number) < minSec() || (raw as number) > AUTO_DELETE_MAX_SEC) throw new DomainError('bad_frame', 'auto_delete');
  return raw as number;
}

/**
 * Личный чат — любой из двоих (не служебный, без блокировки), «Избранное» — сам пользователь, группа и канал — тот, кто
 * меняет информацию. Служебное сообщение и событие chatAutoDelete — всем участникам и на все устройства.
 */
export async function setAutoDelete(userId: number, chatId: number, raw: unknown): Promise<{ autoDeleteSec: number | null }> {
  const sec = validSec(raw);
  return sql.begin(async (tx) => {
    const [c] = await tx`
      select c.kind, c.auto_delete_sec, c.deleted_at,
             exists (select 1 from chat_members o join users u on u.id = o.user_id where o.chat_id = c.id and u.system) as system
        from chats c join chat_members m on m.chat_id = c.id and m.user_id = ${userId}
       where c.id = ${chatId} for update of c`;
    if (!c) throw new DomainError('not_member');
    if (c.deleted_at) throw new DomainError('not_found', 'chat');
    const kind = c.kind as 'direct' | 'group' | 'channel';
    if (kind === 'direct') {
      if (c.system) throw new DomainError('forbidden', 'auto_delete');   // служебный чат «Relay»
      if (await blockedInDirect(tx, chatId, userId)) throw new DomainError('blocked');
    } else {
      const ctx = await groupCtx(tx, chatId, userId, { lock: true });
      isCommunity(ctx);
      if (!hasAdmin(ctx, 'info')) throw new DomainError('forbidden', 'info');   // только админ: разрешение «менять информацию» участникам сюда не относится
    }
    if ((c.auto_delete_sec ?? null) === sec) return { autoDeleteSec: sec };
    await tx`update chats set auto_delete_sec = ${sec} where id = ${chatId}`;
    // само служебное сообщение срока не получает: serviceMessage его не ставит (история смены настройки остаётся)
    await serviceMessage(tx, chatId, userId, 'auto_delete_changed', sec ? { sec } : {}, '', kind);
    await chatEvent(tx, chatId, { type: 'chatAutoDelete', chatId, sec }, kind);
    return { autoDeleteSec: sec };
  });
}

/** Стереть вышедшие сообщения одного чата: транзакция на пачку, чужие замки не ждём (не дошли — следующий проход). */
async function eraseExpired(chatId: number, ids: number[]): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      select m.id, m.thread_id, m.attachment->>'id' as aid, c.kind from messages m join chats c on c.id = m.chat_id
       where m.chat_id = ${chatId} and m.id = any(${ids}::bigint[]) and not m.deleted and m.expires_at <= now()
       for update of m skip locked`;
    const threads = new Set<number>(), files = new Set<string>();
    for (const r of rows) {
      const id = Number(r.id), kind = r.kind as 'direct' | 'group' | 'channel';
      if (r.aid) files.add(r.aid as string);
      await erase(tx, chatId, id, kind);
      // пост канала — и его копия в группе обсуждения, как при удалении руками: тред остаётся, шапка — «Пост удалён»
      if (kind === 'channel') await withCopy(tx, chatId, id, (groupId, copyId) => erase(tx, groupId, copyId, 'group'));
      if (r.thread_id != null) threads.add(Number(r.thread_id));
    }
    for (const t of threads) await recountThread(tx, chatId, t);
    if (files.size) await dropUnreferenced(tx, [...files]);
    return rows.length;
  });
}

/**
 * Шаг задачи messages.expire: до batch вышедших сообщений по индексу, по транзакции на чат. Повтор безопасен: стёртое в выборку
 * не попадает. Сбой одного чата не держит остальные — он останется в выборке следующего прохода.
 */
export async function expireStep(batch = 200): Promise<{ erased: number; more: boolean }> {
  const rows = await sql`
    select m.chat_id, m.id from messages m join chats c on c.id = m.chat_id and c.deleted_at is null
     where m.expires_at is not null and m.expires_at <= now() and not m.deleted
     order by m.expires_at limit ${batch}`;
  const byChat = new Map<number, number[]>();
  for (const r of rows) {
    const chatId = Number(r.chat_id), list = byChat.get(chatId);
    if (list) list.push(Number(r.id)); else byChat.set(chatId, [Number(r.id)]);
  }
  let erased = 0, failed = false;
  for (const [chatId, ids] of byChat) {
    try { erased += await eraseExpired(chatId, ids); }
    catch (e) { failed = true; console.error('auto-delete:', chatId, e); }
  }
  return { erased, more: rows.length === batch && !failed };
}

/**
 * Уничтожить срочные ключи прошедших корзин, в которых не осталось живых сообщений (минута запаса — на расхождение часов
 * процессов). NOTIFY chat_keys сбрасывает кэши ключей этого чата во всех процессах (миграция 137).
 */
export async function destroyExpiredKeys(batch = 200): Promise<number> {
  const gone = await sql`
    delete from keys.chat_keys where (chat_id, version) in (
      select k.chat_id, k.version from keys.chat_keys k
       where k.expires_at is not null and k.expires_at < now() - interval '1 minute'
         and not exists (select 1 from messages m where m.chat_id = k.chat_id and m.expires_at is not null and m.expires_at <= k.expires_at and not m.deleted)
       limit ${batch})
    returning chat_id`;
  return gone.length;
}
