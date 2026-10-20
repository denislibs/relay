import { tabsOf } from './derive';
import { termsOf } from './idb';
import { MEMBERS_FULL, MEMBERS_PART } from './members';
import { PROFILE_LIST_MAX } from './profileLists';
import type { Store } from './store';
import { PENDING_BASE, type LocalChat, type LocalMessage } from './types';

/*
 * Уборка кэша: пределы хранения (согласованы).
 * Сообщения — у каждого чата последние perChat + окно, открытое сейчас; всего больше total — давно не открытые чаты
 * урезаются до последних stale. Не трогаем неотправленные, закреплённые и последнее сообщение чата. Отрезки истории
 * сжимаются вокруг стёртого (никогда не обещают сообщений, которых нет), слова указателя стираются в той же транзакции.
 * Люди — больше people: стираем тех, на кого никто не ссылается; с ними — их музыку и фото профиля.
 * Участники — у групп больше MEMBERS_FULL остаются первые MEMBERS_PART; списки профиля — по PROFILE_LIST_MAX.
 */
export const EVICT_LIMITS = { perChat: 500, total: 50_000, stale: 50, people: 5_000 };
export type EvictLimits = typeof EVICT_LIMITS;

/** Что сейчас видит интерфейс — не трогаем. */
export interface EvictKeep {
  /** открытые окна лент и вкладок медиа: ключи сообщений по чатам (с исходниками цитат) */
  windows: Map<number, Set<string>>;
  /** люди подписок (people, user, presence, списки профиля) и контакты с очередью */
  people: Set<number>;
  /** чаты с открытым списком участников */
  members: Set<number>;
}

export interface EvictStats { messages: number; users: number; members: number; lists: number }

type Removed = { key: string; id: number | null; sort: number; media: boolean };

/** Подтверждённые сообщения чата (неотправленные — с PENDING_BASE, их не считаем и не трогаем). */
const serverRange = (chatId: number) => IDBKeyRange.bound([chatId, -Infinity], [chatId, PENDING_BASE], false, true);

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

/** Сколько подтверждённых сообщений у каждого чата в IDB — одной транзакцией. */
async function countAll(db: IDBDatabase, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const t = db.transaction('messages'), ix = t.objectStore('messages').index('byChat');
  for (const id of ids) { const r = ix.count(serverRange(id)); r.onsuccess = () => out.set(id, r.result); }
  await done(t);
  return out;
}

/**
 * Оставить у чата keep новейших подтверждённых (и защищённые): старее floor (keep-е с конца) — стереть строку и её слова,
 * одной транзакцией. null — стирать нечего.
 */
async function trimChat(db: IDBDatabase, chatId: number, keep: number, prot: { keys: Set<string>; ids: Set<number> }): Promise<{ floor: number; removed: Removed[]; kept: number[] } | null> {
  const t = db.transaction(['messages', 'terms'], 'readwrite');
  const ix = t.objectStore('messages').index('byChat'), terms = t.objectStore('terms');
  const removed: Removed[] = [], kept: number[] = [];
  let floor: number | null = null, skipped = keep <= 1;
  const top = ix.openCursor(serverRange(chatId), 'prev');
  top.onsuccess = () => {
    const c = top.result;
    if (!c) return;   // сообщений не больше keep
    if (!skipped) { skipped = true; c.advance(keep - 1); return; }
    floor = (c.value as LocalMessage).sort;
    const below = ix.openCursor(IDBKeyRange.bound([chatId, -Infinity], [chatId, floor], false, true));
    below.onsuccess = () => {
      const d = below.result;
      if (!d) return;
      const m = d.value as LocalMessage & { tab?: string };
      if (prot.keys.has(m.key) || (m.id != null && prot.ids.has(m.id))) kept.push(m.sort);
      else {
        for (const term of termsOf(m)) terms.delete([term, m.chatId, m.sort]);
        removed.push({ key: m.key, id: m.id, sort: m.sort, media: !!m.tab || tabsOf(m).length > 0 });
        d.delete();
      }
      d.continue();
    };
  };
  await done(t);
  return floor == null ? null : { floor, removed, kept };
}

/**
 * Отрезки после стирания: стёртое (removed) рвёт отрезок, оставшееся (kept — защищённые ниже floor, и всё от floor)
 * образует отрезки поменьше. Край, у которого ничего не стёрто, остаётся прежним; край у стёртого — на оставшемся
 * сообщении. Отрезки только сжимаются: не обещают того, чего нет. removed и kept — по возрастанию.
 */
export function trimRanges(ranges: readonly [number, number][], floor: number, removed: number[], kept: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    const cut = removed.filter((s) => a <= s && s <= b);
    if (!cut.length) { out.push([a, b]); continue; }
    const pts: [number, boolean][] = [...cut.map((s): [number, boolean] => [s, false]), ...kept.filter((s) => a <= s && s <= b).map((s): [number, boolean] => [s, true])];
    if (floor <= b) pts.push([Math.max(floor, a), true]);   // от floor всё на месте — до конца отрезка
    pts.sort((x, y) => x[0] - y[0]);
    let run: [number, number] | null = null, before = false;
    for (const [s, keep] of pts) {
      if (keep) { if (run) run[1] = s; else run = [before ? s : a, s]; }
      else { if (run) { out.push(run); run = null; } before = true; }
    }
    if (run) { run[1] = b; out.push(run); }
  }
  return out;
}

/** Применить стирание к чату в памяти: сообщения, отрезки, начало истории, seed, вкладки медиа. */
function applyTrim(store: Store, chat: LocalChat, floor: number, removed: Removed[], kept: number[]): void {
  store.dropMessages(chat.id, removed);
  const was = chat.ranges;
  const sorts = removed.map((r) => r.sort).sort((x, y) => x - y);
  chat.ranges = trimRanges(was, floor, sorts, kept.slice().sort((x, y) => x - y));
  // начало первого отрезка стёрто — до начала истории больше не подряд
  if (chat.historyStart && (!chat.ranges.length || !was.length || chat.ranges[0][0] !== was[0][0])) delete chat.historyStart;
  // seed — ниже начала живого отрезка: то, что он проверял, стёрто
  const live = chat.ranges[chat.ranges.length - 1];
  if (chat.seed != null && (!live || live[0] > chat.seed)) delete chat.seed;
  // вкладки медиа знали страницы подряд — среди них стёртые: заново с сервера (счётчики верны)
  if (removed.some((r) => r.media)) delete chat.mediaDone;
  store.saveChat(chat);
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Уборка. Сначала flush (память и IDB совпадают), потом по чату за раз с паузой между чатами — не держим воркер.
 * В конце flush: отрезки, люди, участники и списки — на диск.
 */
export async function evict(store: Store, db: IDBDatabase, keep: EvictKeep, limits: EvictLimits = EVICT_LIMITS): Promise<EvictStats> {
  const stats: EvictStats = { messages: 0, users: 0, members: 0, lists: 0 };
  await store.flush();

  // ---------- сообщения ----------
  const counts = await countAll(db, [...store.chats.keys()]);
  const target = new Map<number, number>();
  let total = 0;
  for (const [id, n] of counts) { const k = Math.min(n, limits.perChat); target.set(id, k); total += k; }
  if (total > limits.total) {
    // давно не открытые (никогда — первыми, потом по времени последнего сообщения) — до stale; открытые сейчас не трогаем
    const stale = [...store.chats.values()].filter((c) => !keep.windows.has(c.id) && (target.get(c.id) ?? 0) > limits.stale)
      .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || (a.lastAt < b.lastAt ? -1 : a.lastAt > b.lastAt ? 1 : a.id - b.id));
    for (const c of stale) {
      if (total <= limits.total) break;
      total -= target.get(c.id)! - limits.stale;
      target.set(c.id, limits.stale);
    }
  }
  for (const [id, n] of counts) {
    const k = target.get(id)!;
    if (n <= k) continue;
    const chat = store.chats.get(id);
    if (!chat) continue;
    const prot = { keys: new Set(keep.windows.get(id) ?? []), ids: new Set(chat.pinned ?? []) };
    if (chat.last) prot.keys.add(chat.last.key);
    const gen = store.resetGen;
    const r = await trimChat(db, id, k, prot);
    const now = store.chats.get(id);   // пока стирали, чат могли удалить, а кэш — сбросить (tooLong)
    if (r && now && gen === store.resetGen) { applyTrim(store, now, r.floor, r.removed, r.kept); stats.messages += r.removed.length; }
    await pause();
  }

  // ---------- участники ----------
  for (const c of store.chats.values()) {
    if (!c.group || keep.members.has(c.id)) continue;
    const n = store.members.list(c.id).length;
    if (n <= MEMBERS_PART || (c.membersDone !== false && n <= MEMBERS_FULL && (c.group.members ?? 0) <= MEMBERS_FULL)) continue;
    stats.members += store.members.trim(c.id, MEMBERS_PART);
    if (c.membersDone !== false) { c.membersDone = false; store.saveChat(c); }
    store.members.touched.add(c.id);
  }

  // ---------- люди ----------
  if (store.users.rows.size > limits.people) {
    await store.flush();   // сообщения, пришедшие за уборку, — в IDB: их авторов увидит обход ниже
    const refs = new Set<number>(keep.people);
    refs.add(store.userId);
    const note = (m: Pick<LocalMessage, 'senderId' | 'fwdFrom' | 'reactions'> | null | undefined) => {
      if (!m) return;
      refs.add(m.senderId);
      if (m.fwdFrom) refs.add(m.fwdFrom.userId);
      for (const r of m.reactions ?? []) refs.add(r.userId);
    };
    for (const c of store.chats.values()) { if (c.peerId != null) refs.add(c.peerId); note(c.last); note(c.snapLast); }
    for (const r of store.members.table.rows.values()) refs.add(r.userId);
    for (const id of store.contacts.table.rows.keys()) refs.add(id);
    for (const id of store.blocks.table.rows.keys()) refs.add(id);
    for (const q of store.quotes.values()) refs.add(q.senderId);
    const t = db.transaction('messages'), cur = t.objectStore('messages').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return; note(c.value as LocalMessage); c.continue(); };
    await done(t);
    for (const id of [...store.users.rows.keys()]) {
      if (refs.has(id)) continue;
      store.users.delete(id);
      store.profileLists.dropUser(id);
      stats.users++;
    }
  }

  // ---------- музыка и фото профиля ----------
  stats.lists = store.profileLists.cap(PROFILE_LIST_MAX);

  await store.flush();
  return stats;
}
