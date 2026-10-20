// Содержимое сообщения хранится шифром (столбец messages.content): текст, разметка, чек-лист, статья, превью ссылки
// и текстовые поля вложения (имя, название, исполнитель, превью-картинка). Открытыми остаются метаданные, по которым
// работают запросы: вид, id и тип файла, размеры, отправитель, время, служебные кнопки.
// Ключ — ключ чата (crypto/chatKeys.ts); AAD — «messages|чат|client_id|content»: client_id известен до вставки и
// не меняется, поэтому шифр нельзя переставить в другую строку.
//
// Запись: contentColumns(...) → значения столбцов (шифр + пустые открытые поля). Чтение: openRows(rows) после выборки
// возвращает строкам открытые поля — toMessage дальше работает как раньше. Правка: updateContent(...) под блокировкой строки.
// Строки без content (до шифрования) читаются как есть; их догоняет задача crypto.encrypt.
import { sql, type Tx } from '../db';
import { CryptoError, keyVersionOf, open, seal } from '../crypto/aead';
import { chatKey, currentChatKey } from '../crypto/chatKeys';

/** Текстовые поля вложения — в шифр; остальное (id, kind, mime, size, w, h, duration…) — открыто. */
const ATTACHMENT_TEXT = ['name', 'title', 'performer', 'thumb'] as const;

export interface Content {
  body: string;
  entities: unknown[] | null;
  todo: unknown | null;
  blocks: unknown[] | null;
  link: unknown | null;
  attachment: Record<string, unknown> | null;   // целиком: в шифр уходят только текстовые поля
}

/** Шифровать ли новые записи. Выключение (RELAY_ENCRYPT=0) — только для отладки: чтение шифра работает всегда. */
export const encryptionOn = (): boolean => process.env.RELAY_ENCRYPT !== '0';

const aad = (chatId: number, clientId: string) => `messages|${chatId}|${clientId}|content`;
const draftAad = (userId: number, chatId: number) => `drafts|${userId}|${chatId}|content`;

function splitAttachment(att: Record<string, unknown> | null): { plain: Record<string, unknown> | null; text: Record<string, unknown> | null } {
  if (!att) return { plain: null, text: null };
  const plain: Record<string, unknown> = { ...att }, text: Record<string, unknown> = {};
  for (const k of ATTACHMENT_TEXT) if (k in plain) { text[k] = plain[k]; delete plain[k]; }
  return { plain, text: Object.keys(text).length ? text : null };
}

/**
 * Значения столбцов для записи сообщения: шифр в content, открытые текстовые столбцы пустые (body '' — столбец not null).
 * attachment — без текстовых полей. Шифрование выключено — всё как раньше, content null.
 */
const LINK = /(https?:\/\/|www\.)[^\s]/i;
/** Есть ли в тексте ссылка (как прежний фильтр вкладки «Ссылки»: адрес в тексте или оформление-ссылка). */
export const hasLink = (c: Pick<Content, 'body' | 'entities'>): boolean =>
  LINK.test(c.body) || (Array.isArray(c.entities) && c.entities.some((e) => (e as { type?: string }).type === 'link'));

export async function contentColumns(chatId: number, clientId: string, c: Content, tx?: Tx): Promise<Content & { content: Buffer | null; hasLink: boolean }> {
  if (!encryptionOn()) return { ...c, content: null, hasLink: hasLink(c) };
  const { plain, text } = splitAttachment(c.attachment);
  const k = await currentChatKey(chatId, tx);
  const payload = JSON.stringify({ b: c.body, e: c.entities ?? null, t: c.todo ?? null, k: c.blocks ?? null, l: c.link ?? null, a: text });
  const content = Buffer.from(await seal(k.key, k.version, payload, aad(chatId, clientId)));
  return { body: '', entities: null, todo: null, blocks: null, link: null, attachment: plain, content, hasLink: hasLink(c) };
}

async function openContent(chatId: number, clientId: string, sealed: Uint8Array, tx?: Tx): Promise<Content | null> {
  try {
    const key = await chatKey(chatId, keyVersionOf(sealed), tx);
    const p = JSON.parse(await open(key, sealed, aad(chatId, clientId))) as { b: string; e: unknown[] | null; t: unknown; k: unknown[] | null; l: unknown; a: Record<string, unknown> | null };
    return { body: p.b, entities: p.e, todo: p.t, blocks: p.k, link: p.l, attachment: p.a };
  } catch (e) {
    // ключ чата уничтожен (чат удалён) — содержимого больше нет; остальное — настоящая ошибка
    if (e instanceof CryptoError && e.code === 'no_key') return null;
    throw e;
  }
}

/**
 * Открыть строки messages после выборки (на месте): body, entities, todo, blocks, link и текст вложения — обратно
 * в свои поля. prefix — у выборок с переименованными столбцами (список чатов: m_body, m_content…).
 */
export async function openRows<T extends Record<string, unknown>>(rows: T[], prefix = '', tx?: Tx): Promise<T[]> {
  const col = (n: string) => prefix + n;
  await Promise.all(rows.map(async (r) => {
    const sealed = r[col('content')] as Uint8Array | null | undefined;
    if (!sealed) return;
    const c = await openContent(Number(r[col('chat_id')]), r[col('client_id')] as string, new Uint8Array(sealed), tx);
    const row = r as Record<string, unknown>;
    if (!c) { row[col('body')] = ''; row[col('entities')] = null; row[col('todo')] = null; row[col('blocks')] = null; row[col('link')] = null; return; }
    row[col('body')] = c.body;
    row[col('entities')] = c.entities;
    row[col('todo')] = c.todo;
    row[col('blocks')] = c.blocks;
    row[col('link')] = c.link;
    if (c.attachment && row[col('attachment')]) row[col('attachment')] = { ...(row[col('attachment')] as object), ...c.attachment };
  }));
  return rows;
}

/** Строка сообщения под блокировкой, уже открытая; null — нет такой. */
export async function lockOpen(tx: Tx, chatId: number, id: number): Promise<Record<string, unknown> | null> {
  const [row] = await tx`select * from messages where chat_id = ${chatId} and id = ${id} for update`;
  if (!row) return null;
  await openRows([row], '', tx);
  return row;
}

/**
 * Изменить содержимое сообщения: прочитать под блокировкой, открыть, поменять, запечатать заново. change возвращает
 * новые поля (то, чего нет, — как было) или false — ничего не писать. extra — открытые столбцы рядом (edited_at, buttons…).
 */
export async function updateContent(tx: Tx, chatId: number, id: number,
  change: (c: Content, row: Record<string, unknown>) => Partial<Content> | false,
  extra: (row: Record<string, unknown>) => Record<string, unknown> = () => ({})): Promise<Record<string, unknown> | null> {
  const row = await lockOpen(tx, chatId, id);
  if (!row) return null;
  const cur: Content = { body: row.body as string, entities: (row.entities as unknown[]) ?? null, todo: row.todo ?? null, blocks: (row.blocks as unknown[]) ?? null, link: row.link ?? null, attachment: (row.attachment as Record<string, unknown>) ?? null };
  const patch = change(cur, row);
  if (patch === false) return null;
  const next: Content = { ...cur, ...patch };
  const cols = await contentColumns(chatId, row.client_id as string, next, tx);
  const set = {
    body: cols.body,
    entities: cols.entities && cols.entities.length ? sql.json(cols.entities as never) : null,
    todo: cols.todo ? sql.json(cols.todo as never) : null,
    blocks: cols.blocks ? sql.json(cols.blocks as never) : null,
    link: cols.link ? sql.json(cols.link as never) : null,
    attachment: cols.attachment ? sql.json(cols.attachment as never) : null,
    content: cols.content,
    has_link: cols.hasLink,
    ...extra(row),
  };
  const [updated] = await tx`update messages set ${tx(set as never)} where chat_id = ${chatId} and id = ${id} returning *`;
  await openRows([updated], '', tx);
  return updated;
}

/* ---------- черновики ---------- */

export async function sealDraft(userId: number, chatId: number, text: string, entities: unknown[], tx?: Tx): Promise<{ text: string; entities: unknown[] | null; content: Buffer | null }> {
  if (!encryptionOn() || !text) return { text, entities: entities.length ? entities : null, content: null };
  const k = await currentChatKey(chatId, tx);
  const content = Buffer.from(await seal(k.key, k.version, JSON.stringify({ t: text, e: entities.length ? entities : null }), draftAad(userId, chatId)));
  return { text: '', entities: null, content };
}

/** Открыть строки drafts на месте (нужны user_id, chat_id, content). */
export async function openDrafts<T extends Record<string, unknown>>(rows: T[], userId?: number): Promise<T[]> {
  await Promise.all(rows.map(async (r) => {
    const sealed = r.content as Uint8Array | null | undefined;
    if (!sealed) return;
    const row = r as Record<string, unknown>;
    const uid = Number(row.user_id ?? userId), chatId = Number(row.chat_id);
    try {
      const s = new Uint8Array(sealed);
      const p = JSON.parse(await open(await chatKey(chatId, keyVersionOf(s)), s, draftAad(uid, chatId))) as { t: string; e: unknown[] | null };
      row.text = p.t; row.entities = p.e;
    } catch (e) {
      if (e instanceof CryptoError && e.code === 'no_key') { row.text = ''; row.entities = null; return; }
      throw e;
    }
  }));
  return rows;
}

/* ---------- произвольные данные чата (задачи очереди) ---------- */

/** Запечатать значение ключом чата (base64): текст в jobs/jobs_dead не лежит открытым. */
export async function sealForChat(chatId: number, value: unknown, place: string): Promise<string> {
  const k = await currentChatKey(chatId);
  return Buffer.from(await seal(k.key, k.version, JSON.stringify(value), `${place}|${chatId}`)).toString('base64');
}
export async function openForChat<T>(chatId: number, b64: string, place: string): Promise<T> {
  const s = new Uint8Array(Buffer.from(b64, 'base64'));
  return JSON.parse(await open(await chatKey(chatId, keyVersionOf(s)), s, `${place}|${chatId}`)) as T;
}

/** Сообщение по ссылке, открытое (задачи push, поиск): null — нет или удалено. */
export async function loadOpen(chatId: number, id: number): Promise<Record<string, unknown> | null> {
  const [row] = await sql`select * from messages where chat_id = ${chatId} and id = ${id}`;
  if (!row) return null;
  await openRows([row]);
  return row;
}

/* ---------- поиск без индекса: перебор с расшифровкой ---------- */

/** Совпадает ли открытая строка с запросом: подстрока без учёта регистра в тексте или текстовых полях вложения. */
export function rowMatches(r: Record<string, unknown>, q: string, bodyOnly = false): boolean {
  const needle = q.toLocaleLowerCase('ru');
  if (String(r.body ?? '').toLocaleLowerCase('ru').includes(needle)) return true;
  if (bodyOnly) return false;
  const a = r.attachment as Record<string, unknown> | null;
  return !!a && ['name', 'title', 'performer'].some((k) => String(a[k] ?? '').toLocaleLowerCase('ru').includes(needle));
}

export const SCAN_BATCH = 500, SCAN_MAX = 5000;

/**
 * Текст в шифре — SQL по нему не фильтрует. batch(before) отдаёт следующую пачку кандидатов (новые сверху, id < before),
 * строки открываются и фильтруются здесь. Останавливаемся на limit + 1 совпадении или после SCAN_MAX строк.
 */
export async function scanMatching<T extends Record<string, unknown>>(batch: (before: number | null) => Promise<T[]>, match: (r: T) => boolean, limit: number, before: number | null = null): Promise<{ rows: T[]; more: boolean }> {
  const found: T[] = [];
  let scanned = 0, cursor = before;
  for (;;) {
    const rows = await batch(cursor);
    if (!rows.length) return { rows: found, more: false };
    await openRows(rows);
    for (const r of rows) {
      if (match(r)) found.push(r);
      if (found.length > limit) return { rows: found.slice(0, limit), more: true };
    }
    scanned += rows.length;
    cursor = Number(rows[rows.length - 1].id);
    // дальше не ищем: страница короче, но «ещё» — следующий запрос продолжит с курсора
    if (scanned >= SCAN_MAX) return { rows: found, more: true };
    if (rows.length < SCAN_BATCH) return { rows: found, more: false };
  }
}

/* ---------- старые строки: задача crypto.encrypt ---------- */

/**
 * Один шаг шифрования строк, написанных до шифрования: пачка сообщений по id (курсор after) и все черновики без
 * шифра. Строка, которую успели изменить (content уже есть), не трогается. done — открытых строк не осталось.
 */
export async function encryptLegacyStep(after = 0, batch = 500): Promise<{ next: number; encrypted: number; done: boolean }> {
  if (!encryptionOn()) return { next: after, encrypted: 0, done: true };
  const rows = await sql`
    select * from messages
     where id > ${after} and content is null and not deleted
       and (body <> '' or entities is not null or todo is not null or blocks is not null or link is not null
            or (attachment is not null and (attachment ? 'name' or attachment ? 'title' or attachment ? 'performer' or attachment ? 'thumb')))
     order by id limit ${batch}`;
  let encrypted = 0;
  for (const r of rows) {
    const c = await contentColumns(Number(r.chat_id), r.client_id as string, {
      body: r.body as string, entities: (r.entities as unknown[]) ?? null, todo: r.todo ?? null, blocks: (r.blocks as unknown[]) ?? null,
      link: r.link ?? null, attachment: (r.attachment as Record<string, unknown>) ?? null,
    }).catch(() => null);   // чат без ключа и создать нельзя (удаляется) — пропускаем
    if (!c) continue;
    const done = await sql`
      update messages set body = ${c.body}, entities = null, todo = null, blocks = null, link = null,
             attachment = ${c.attachment ? sql.json(c.attachment as never) : null}, content = ${c.content}, has_link = ${c.hasLink}
       where chat_id = ${r.chat_id} and id = ${r.id} and content is null returning 1`;
    encrypted += done.length;
  }
  if (!rows.length) {
    const drafts = await sql`select user_id, chat_id, text, entities from drafts where content is null and text <> ''`;
    for (const d of drafts) {
      const s = await sealDraft(Number(d.user_id), Number(d.chat_id), d.text as string, (d.entities as unknown[]) ?? []).catch(() => null);
      if (!s) continue;
      await sql`update drafts set text = ${s.text}, entities = null, content = ${s.content} where user_id = ${d.user_id} and chat_id = ${d.chat_id} and content is null`;
      encrypted++;
    }
    return { next: after, encrypted, done: true };
  }
  return { next: Number(rows[rows.length - 1].id), encrypted, done: false };
}
