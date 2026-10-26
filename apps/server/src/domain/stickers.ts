import { FAVED_STICKERS_LIMIT, RECENT_STICKERS_LIMIT, type MyStickers, type StickerRef, type StickerSet, type StickerSetInfo } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash8, greetingDir } from '../stickers/files';


/** Сколько паков ставим новому пользователю (первые по порядку): пустая панель стикеров — тупик. */
export const DEFAULT_SETS = 8;

const STICKER_COLS = sql`s.id, s.set_id, s.emoji, s.w, s.h, s.format, s.file, s.file_hash, s.outline, ss.short_name`;

export function refOf(r: Record<string, unknown>): StickerRef {
  return {
    id: Number(r.id), setId: Number(r.set_id), emoji: r.emoji as string, w: r.w as number, h: r.h as number,
    format: r.format as StickerRef['format'], url: `/stk/${r.short_name}/${r.file_hash}/${r.file}`, outline: (r.outline as string | null) ?? null,
  };
}

function infoOf(r: Record<string, unknown>): StickerSetInfo {
  const cover: StickerRef | null = r.cover_file ? {
    id: 0, setId: Number(r.id), emoji: '', w: 512, h: 512, format: (String(r.cover_file).split('.').pop() as StickerRef['format']),
    url: `/stk/${r.short_name}/${r.cover_hash}/${r.cover_file}`, outline: (r.cover_outline as string | null) ?? null,
  } : null;
  return { id: Number(r.id), shortName: r.short_name as string, title: r.title as string, kind: r.kind as StickerSetInfo['kind'], count: r.count as number, cover, hash: r.hash as string };
}

// обложка — первый стикер с тем же файлом даёт силуэт (у cover.tgs своего контура нет)
const SET_COLS = sql`ss.id, ss.short_name, ss.title, ss.kind, ss.count, ss.cover_file, ss.cover_hash, ss.hash,
  (select outline from stickers c where c.set_id = ss.id and c.file = ss.cover_file limit 1) as cover_outline`;

export async function getStickerSet(idOrShort: string): Promise<StickerSet | null> {
  const byId = /^\d+$/.test(idOrShort);
  const [set] = await sql`select ${SET_COLS} from sticker_sets ss where ${byId ? sql`ss.id = ${Number(idOrShort)}` : sql`ss.short_name = ${idOrShort}`}`;
  if (!set) return null;
  const rows = await sql`select ${STICKER_COLS} from stickers s join sticker_sets ss on ss.id = s.set_id where s.set_id = ${set.id} order by s.idx`;
  return { ...infoOf(set), stickers: rows.map(refOf) };
}

/** Рекомендуемые паки (по порядку ассетов), страницами. */
export async function featuredSets(offset = 0, limit = 20): Promise<StickerSetInfo[]> {
  const rows = await sql`select ${SET_COLS} from sticker_sets ss where ss.kind = 'sticker' order by ss.position offset ${Math.max(0, offset)} limit ${Math.min(50, limit)}`;
  return rows.map(infoOf);
}

export async function searchSets(q: string, limit = 30): Promise<StickerSetInfo[]> {
  const s = q.trim().toLowerCase().slice(0, 64);
  if (!s) return featuredSets(0, limit);
  const like = '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await sql`select ${SET_COLS} from sticker_sets ss
    where ss.kind = 'sticker' and (lower(ss.title) like ${like} or lower(ss.short_name) like ${like})
    order by (lower(ss.title) like ${s.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}) desc, ss.position limit ${limit}`;
  return rows.map(infoOf);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Стикеры по эмодзи (одному или группе — чип «Любовь» и т. п.): сначала из моих паков, потом недавние, потом остальные (до 100). */
export async function stickersByEmoji(userId: number, emoji: string, limit = 100): Promise<StickerRef[]> {
  const list = [...graphemes.segment(emoji.replace(/\s+/g, '').slice(0, 400))].map((x) => x.segment).slice(0, 50);
  if (!list.length) return [];
  // в паках эмодзи записаны то с вариационным селектором, то без — ищем оба написания
  const variants = [...new Set(list.flatMap((e) => [e, e.replace(/\uFE0F/g, ''), e + '\uFE0F']))];
  const rows = await sql`
    select ${STICKER_COLS},
      (exists (select 1 from user_sticker_sets u where u.user_id = ${userId} and u.set_id = s.set_id)) as mine,
      (exists (select 1 from recent_stickers r where r.user_id = ${userId} and r.sticker_id = s.id)) as recent
    from stickers s join sticker_sets ss on ss.id = s.set_id
    where ss.kind = 'sticker' and s.emoji = any(${variants}::text[])
    order by mine desc, recent desc, ss.position, s.idx limit ${limit}`;
  return rows.map(refOf);
}

/** Эмодзи приветствия (без вариационного селектора): из них выбирается стикер для пустого личного чата. */
export const GREETING_EMOJI = ['👋', '🤝', '🙋', '🫡', '✋', '😊', '👍'];

/**
 * Подборка приветствий Telegram (ASSETS_DIR/greeting: getStickers по 👋⭐️) — хэши файлов. Сами стикеры уже лежат
 * в импортированных паках: ищем их там по хэшу, чтобы клик открывал настоящий пак. Пересчёт по mtime greeting.json.
 */
let greeting: { stamp: number; hashes: Promise<string[]> } | null = null;
function greetingHashes(): Promise<string[]> {
  let stamp = 0;
  try { stamp = statSync(join(greetingDir(), 'greeting.json')).mtimeMs; } catch { greeting = null; return Promise.resolve([]); }
  if (greeting?.stamp === stamp) return greeting.hashes;
  const hashes = (async () => {
    const j = (await Bun.file(join(greetingDir(), 'greeting.json')).json()) as { stickers?: { file?: unknown }[] };
    const out: string[] = [];
    for (const s of j.stickers ?? []) {
      if (typeof s?.file !== 'string' || !/^[0-9]{1,4}\.(tgs|webp)$/.test(s.file)) continue;
      const h = await fileHash8(join(greetingDir(), s.file));
      if (h) out.push(h);
    }
    return out;
  })().catch((e) => { console.warn('greeting:', String(e)); greeting = null; return [] as string[]; });
  greeting = { stamp, hashes };
  return hashes;
}

/**
 * Стикер-приветствие для пустого личного чата: случайный из подборки Telegram (greeting/), а без неё — среди
 * стикеров с эмодзи приветствия, если таких нет — любой. null — паков нет вовсе.
 */
export async function greetingSticker(): Promise<StickerRef | null> {
  const hashes = await greetingHashes();
  if (hashes.length) {
    const [hit] = await sql`
      select ${STICKER_COLS} from stickers s join sticker_sets ss on ss.id = s.set_id
      where ss.kind = 'sticker' and s.file_hash = any(${hashes}::text[]) order by random() limit 1`;
    if (hit) return refOf(hit);
  }
  const [row] = await sql`
    select ${STICKER_COLS} from stickers s join sticker_sets ss on ss.id = s.set_id
    where ss.kind = 'sticker'
    order by (replace(s.emoji, ${'\uFE0F'}, '') = any(${GREETING_EMOJI}::text[])) desc, random() limit 1`;
  return row ? refOf(row) : null;
}

const changed = (tx: Tx, userId: number) => appendUpdates(tx, [{ userId, update: { type: 'myStickers' } }]);

/** Паки по умолчанию — один раз за жизнь аккаунта. */
async function ensureDefaults(userId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const [first] = await tx`insert into user_sticker_init (user_id) values (${userId}) on conflict do nothing returning user_id`;
    if (!first) return;
    await tx`insert into user_sticker_sets (user_id, set_id, position)
      select ${userId}, id, row_number() over (order by position) from sticker_sets where kind = 'sticker' order by position limit ${DEFAULT_SETS}
      on conflict do nothing`;
  });
}

export async function myStickers(userId: number): Promise<MyStickers> {
  await ensureDefaults(userId);
  const sets = await sql`select ${SET_COLS} from user_sticker_sets u join sticker_sets ss on ss.id = u.set_id where u.user_id = ${userId} order by u.position, u.added_at`;
  const recent = await sql`select ${STICKER_COLS} from recent_stickers r join stickers s on s.id = r.sticker_id join sticker_sets ss on ss.id = s.set_id
    where r.user_id = ${userId} order by r.used_at desc limit ${RECENT_STICKERS_LIMIT}`;
  const faved = await sql`select ${STICKER_COLS} from faved_stickers f join stickers s on s.id = f.sticker_id join sticker_sets ss on ss.id = s.set_id
    where f.user_id = ${userId} order by f.faved_at desc limit ${FAVED_STICKERS_LIMIT}`;
  return { sets: sets.map(infoOf), recent: recent.map(refOf), faved: faved.map(refOf) };
}

/** Добавить пак (наверх списка, как в Telegram) или убрать. */
export async function setInstalled(userId: number, setId: number, on: boolean): Promise<void> {
  await ensureDefaults(userId);
  await sql.begin(async (tx) => {
    const [set] = await tx`select id from sticker_sets where id = ${setId}`;
    if (!set) throw new DomainError('not_found', 'sticker set');
    if (on) {
      const [ins] = await tx`insert into user_sticker_sets (user_id, set_id, position)
        values (${userId}, ${setId}, coalesce((select min(position) from user_sticker_sets where user_id = ${userId}), 1) - 1)
        on conflict do nothing returning set_id`;
      if (!ins) return;
    } else {
      const del = await tx`delete from user_sticker_sets where user_id = ${userId} and set_id = ${setId} returning set_id`;
      if (!del.length) return;
    }
    await changed(tx, userId);
  });
}

export async function setFaved(userId: number, stickerId: number, on: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    if (on) {
      const [s] = await tx`select id from stickers where id = ${stickerId}`;
      if (!s) throw new DomainError('not_found', 'sticker');
      await tx`insert into faved_stickers (user_id, sticker_id) values (${userId}, ${stickerId}) on conflict (user_id, sticker_id) do update set faved_at = now()`;
      // больше лимита — самый старый уходит
      await tx`delete from faved_stickers where user_id = ${userId} and sticker_id not in (
        select sticker_id from faved_stickers where user_id = ${userId} order by faved_at desc limit ${FAVED_STICKERS_LIMIT})`;
    } else {
      const del = await tx`delete from faved_stickers where user_id = ${userId} and sticker_id = ${stickerId} returning sticker_id`;
      if (!del.length) return;
    }
    await changed(tx, userId);
  });
}

export async function clearRecent(userId: number, stickerId?: number): Promise<void> {
  await sql.begin(async (tx) => {
    const del = stickerId != null
      ? await tx`delete from recent_stickers where user_id = ${userId} and sticker_id = ${stickerId} returning sticker_id`
      : await tx`delete from recent_stickers where user_id = ${userId} returning sticker_id`;
    if (del.length) await changed(tx, userId);
  });
}

/** Отправка стикера: снимок для сообщения и подъём в недавние (в той же транзакции, что и сообщение). */
export async function stickerForSend(tx: Tx, userId: number, stickerId: number): Promise<StickerRef> {
  const [row] = await tx`select ${STICKER_COLS} from stickers s join sticker_sets ss on ss.id = s.set_id where s.id = ${stickerId}`;
  if (!row) throw new DomainError('not_found', 'sticker');
  await tx`insert into recent_stickers (user_id, sticker_id) values (${userId}, ${stickerId}) on conflict (user_id, sticker_id) do update set used_at = now()`;
  await tx`delete from recent_stickers where user_id = ${userId} and sticker_id not in (
    select sticker_id from recent_stickers where user_id = ${userId} order by used_at desc limit ${RECENT_STICKERS_LIMIT})`;
  await changed(tx, userId);
  return refOf(row);
}
