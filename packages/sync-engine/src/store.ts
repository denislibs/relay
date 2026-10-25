import type { GroupInfo, MyMembership, ThreadGuest } from '@relay/protocol';
import type { Entity, Message, Poll, PollInput, ProfilePhoto, Replies, Update } from '@relay/protocol';
import { getAll, getByChat, req, termsOf, write, type RowPatch, type WriteBatch } from './idb';
import { CACHE_STORES, STORES } from './schema';
import { applyUserUpdated, ProfileCache } from './profile';
import { applyContactsChanged, ContactsCache } from './contacts';
import { SettingsCache } from './settings';
import { applyBlocksChanged, BlocksCache } from './blocks';
import { applyMembersUpdate, MembersCache } from './members';
import { ProfileLists } from './profileLists';
import { onMessage, recomputeLast, tabsOf, unreadAfterRead, unreadOnArrival } from './derive';
import { nextV } from './rows';
import { PENDING_BASE, toQuote, type Item, type LocalChat, type LocalMessage, type OutboxEntry, type QuoteMsg, type ThreadRanges } from './types';

/** Тот же черновик: текст и оформление (порядок ключей в сущностях не важен). */
function sameDraft(a: { text: string; entities?: Entity[] } | null | undefined, b: { text: string; entities?: Entity[] } | null | undefined): boolean {
  const key = (d: typeof a) => d ? d.text + '\u0000' + (d.entities ?? []).map((e) => [e.type, e.offset, e.length, e.url ?? ''].join(':')).sort().join('|') : '';
  return key(a) === key(b);
}

type Range = [number, number];

/** Цитата удалённого сообщения: «Удалённое сообщение», без содержимого. */
/** Опрос до ответа сервера: варианты 1..N, голосов нет (ответ викторины автор знает и так). */
const pendingPoll = (p: PollInput): Poll => ({
  question: p.question, options: p.options.map((text, i) => ({ id: i + 1, text })), multiple: p.multiple, quiz: p.quiz, anonymous: p.anonymous,
  closed: false, closesAt: p.closesIn ? new Date(Date.now() + p.closesIn * 1000).toISOString() : null, voters: 0, counts: p.options.map(() => 0),
});
const deletedQuote = (id: number, senderId: number): QuoteMsg => ({ id, sort: id, body: '', senderId, kind: 'text', deleted: true, attachment: null, todo: null, article: false });
/** События, которые гость треда применяет из threadPush (остальное — состав, закрепы, информация группы — не для него). */
const GUEST_UPDATES = new Set<Update['type']>(['messageEdited', 'messageMarkup', 'messageDeleted', 'reactions', 'reactionCounts', 'linkPreview', 'todoUpdated', 'pollUpdated', 'attachmentUpdated', 'mediaListened']);

/** Сколько последних уведомлений держит запрос notifications. */
const NOTIFY_KEEP = 20;

/**
 * Удалённое сообщение: стирается всё содержимое — текст, оформление, вложение, превью, статья, чек-лист и пересылка.
 * Обычное удалённое на устройстве не остаётся вовсе (removeMessage); пометкой с этими полями живёт только копия поста
 * в группе обсуждения — шапка её треда «Пост удалён».
 */
const DELETED: Partial<LocalMessage> = {
  body: '', deleted: true, reactions: [], entities: [], attachment: null, link: null, blocks: null, fwdFrom: null, todo: undefined, listened: undefined, buttons: null,
  reactionCounts: undefined, myReaction: undefined,
};

/**
 * Сообщение журнала (или подтверждение отправки) продлевает живой (последний) отрезок: всё новее него приходит
 * подряд. Внутри отрезка — ничего; старее начала живого и вне отрезков — не продлевает (непрерывность не доказана —
 * это сделает страница истории). own — своё отправленное: отрезок начат снимком (seed), пока сообщение
 * отправлялось, и его id ниже начала — начало опускается до него (не залезая на предыдущий отрезок); сообщения
 * между ним и seed догрузит страница истории перед seed (движок, ensureHistory), seed остаётся до неё.
 */
function extendLive(chat: Pick<LocalChat, 'ranges' | 'seed' | 'snapLast'>, sort: number, own = false): void {
  const ranges = chat.ranges, n = ranges.length, last = ranges[n - 1];
  if (!last) ranges.push([sort, sort]);
  else if (sort > last[1]) last[1] = sort;
  else if (own && chat.seed != null && sort < last[0] && (n < 2 || sort > ranges[n - 2][1])) last[0] = sort;
  if (sort === chat.snapLast?.sort) delete chat.snapLast;   // журнал доставил само это сообщение — до него всё подряд
}

/**
 * Последнее сообщение чата из снимка или страницы диалогов. Отрезков нет (первый вход, tooLong, новый чат) —
 * с него начинается живой отрезок. Новее живого — не доказано, что подряд: страница диалогов обычно обгоняет
 * журнал, который его вот-вот доставит. Запоминаем (snapLast); не доставит до конца догонки — дыра (settleSnapshots).
 */
function snapshotLive(chat: LocalChat, m: LocalMessage): boolean {
  const sort = m.sort, last = chat.ranges[chat.ranges.length - 1];
  if (!last) { chat.ranges.push([sort, sort]); chat.seed = sort; return true; }
  if (sort <= last[1]) return true;
  if (sort >= (chat.snapLast?.sort ?? 0)) chat.snapLast = m;
  return false;   // ждёт журнала
}

/**
 * Страница истории от at: older — всё между lo и at подряд (end — и до начала истории), newer — всё между at и hi
 * (end — до самого нового). Сливается с отрезком, где at (null — страница с новейшего края: сама по себе живой
 * отрезок), и со всеми отрезками, которые задевает.
 */
export function addPage(ranges: Range[], lo: number | null, hi: number | null, at: number | null, dir: 'older' | 'newer', end: boolean): Range[] {
  const i = at == null ? -1 : ranges.findIndex((r) => r[0] <= at && at <= r[1]);
  let span: Range | null = i >= 0 ? [ranges[i][0], ranges[i][1]] : null;
  if (lo != null) span = !span ? [lo, hi!] : dir === 'older' ? [Math.min(span[0], lo), span[1]] : [span[0], Math.max(span[1], hi!)];
  if (!span) return ranges;   // пустая страница вне отрезков
  const out: Range[] = [];
  for (const r of ranges) {
    const below = r[1] < span[0] && !(end && dir === 'older'), above = r[0] > span[1] && !(end && dir === 'newer');
    if (below || above) out.push(r);
    else span = [Math.min(span[0], r[0]), Math.max(span[1], r[1])];
  }
  out.push(span);
  return out.sort((a, b) => a[0] - b[0]);
}

export interface ChatSummary {
  draft?: { text: string; at: string } | null;
  pinned?: number[];
  muteUntil?: number | null;
  pinnedAt?: number | null;
  archived?: boolean;
  unreadMark?: boolean;
  sortAt?: string;
  id: number;
  kind: 'direct' | 'group' | 'channel';
  title: string | null;
  lastReadId: number;
  unread: number;
  unreadMentions?: number;   // непрочитанные упоминания меня (основная лента и треды)
  unreadReactions?: number;  // непрочитанные реакции на мои сообщения
  last: Message | null;
  peer?: { id: number; name: string; system?: true; photo?: ProfilePhoto | null } | null;
  peerReadUpTo?: number;
  group?: GroupInfo;
  me?: MyMembership;
  seq?: number;            // журнал чата (группы, каналы): текущий номер
  archivedAtId?: number;   // граница архива
}

/**
 * Доменное состояние в памяти воркера. Каждое изменение помечает грязные записи;
 * `flush()` пишет их в IDB одной транзакцией вместе с lastSeq.
 * Сообщения чата держатся в памяти только для загруженных чатов (`loadChatMessages`);
 * у остальных чатов в памяти лишь последнее сообщение (`chat.last`).
 */
/**
 * Просмотры и реакции-счётчики поста: журнал (newMessage) их не несёт — нет поля значит «не знаю», а не ноль, и
 * прежнее значение остаётся. Просмотры только растут. Счётчики пришли (история) — с ними и моя реакция (нет — не ставил).
 */
function postExtras(m: Message, prev: LocalMessage | undefined, threadRead?: (chatId: number, copyId: number) => number | undefined): Partial<LocalMessage> {
  const out: Partial<LocalMessage> = {};
  // комментарии: история канала несёт replies с моей прочитанностью; журнал — нет (не затирать); прочитанность только растёт
  const r: Replies | undefined = m.replies ?? prev?.replies;
  if (r) {
    const same = prev?.replies && prev.replies.copyId === r.copyId && prev.replies.chatId === r.chatId;
    const read = Math.max(r.readMaxId ?? 0, same ? prev!.replies!.readMaxId ?? 0 : 0, threadRead?.(r.chatId, r.copyId) ?? 0);
    out.replies = { ...r, ...(read ? { readMaxId: read } : {}) };
  }
  const views = Math.max(m.views ?? 0, prev?.views ?? 0);
  if (m.views != null || prev?.views != null) out.views = views;
  if (m.reactionCounts) { out.reactionCounts = m.reactionCounts; if (m.myReaction) out.myReaction = m.myReaction; }
  else if (prev?.reactionCounts) { out.reactionCounts = prev.reactionCounts; if (prev.myReaction) out.myReaction = prev.myReaction; }
  return out;
}

export class Store {
  /** счётчик sessionsChanged из журнала (не хранится): по нему интерфейс перечитывает сеансы */
  sessionsRev = 0;
  stickersRev = 0;   // мои стикеры изменились (журнал, переподключение): интерфейс перечитывает
  chats = new Map<number, LocalChat>();
  outbox = new Map<string, OutboxEntry>();
  pendingReads = new Map<number, number>();
  lastSeq = 0;
  /** Журналы чатов (группы, каналы): номер, до которого события чата применены. Правила — engine.ts (chat journal). */
  chatSeq = new Map<number, number>();
  private dirtyChatSeq = new Set<number>();
  /** hello {since}: мс по часам сервера последней полной сверки (личная догонка и все syncChat завершены) */
  since = 0;
  /** Подсказки движку из applyChats/membership: new — чат появился без строки, ahead — журнал чата ушёл вперёд */
  seqHints = new Map<number, 'new' | 'ahead'>();
  /**
   * Превью публичных каналов без подписки (как в Telegram): чат живёт в памяти рядом с остальными — лента, отрезки,
   * журнал чата (chatSeq, пока движок его смотрит, watchChat), — но это не строка списка: не в «Чатах» и счётчиках,
   * ни строка, ни сообщения, ни номер журнала не пишутся в IndexedDB, уведомлений нет. Вступил (membership) —
   * promote: обычный чат, всё уже загруженное ложится в кэш без перезагрузки ленты.
   */
  previews = new Set<number>();
  /** снимок с сервера уже лежит в кэше (иначе показывать нечего — идёт первая загрузка) */
  hydrated = false;
  /** Поколение базы сервера, с которым синхронизирован кэш. */
  epoch: string | null = null;
  /** Подгрузка диалогов страницами: курсор следующей страницы (время в мс + id) и «дальше пусто». */
  dialogsAt = 0;
  dialogsId = 0;
  dialogsDone = false;
  dialogsTotal = 0;   // сколько диалогов всего (с первой страницы): высота списка до конца подгрузки
  /** чаты, изменившиеся с последнего прохода подписок */
  touched = new Set<number>();
  /** свой профиль и кэш чужих (profile.ts) */
  profile!: ProfileCache;
  /** чужие профили (таблица внутри profile) */
  get users() { return this.profile.users; }
  /** контакты (contacts.ts) */
  contacts!: ContactsCache;
  /** настройки аккаунта (settings.ts) */
  settings!: SettingsCache;
  /** чёрный список (blocks.ts) */
  blocks!: BlocksCache;
  /** участники групп (members.ts) */
  members!: MembersCache;
  /** музыка и фото профиля (profileLists.ts) */
  profileLists!: ProfileLists;
  /** строке списка нужен профиль собеседника, которого нет в people; движок спросит GET /users/:id */
  wantUser: (userId: number) => void = () => {};
  /** контакт зрителя с учётом очереди операций (names.ts); движок подставляет вид с очередью */
  contactOf: (userId: number) => { firstName: string; lastName: string; pending?: boolean } | undefined = (id) => this.contacts.table.get(id);

  private messages = new Map<number, Map<string, LocalMessage>>();
  private loaded = new Set<number>();
  private dirtyChats = new Set<number>();
  private dirtyMessages = new Map<string, LocalMessage>();
  private dirtyOutbox = new Set<string>();
  /** правки строк незагруженных сообщений (удаление/правка с сервера) — применяются к IDB при записи */
  private rowPatches = new Map<string, RowPatch>();   // по chatId:id — правки одного сообщения слиты в одну
  /** строки указателя слов, которые правка/ack/удаление сделали лишними (ключ IDB), до ближайшей записи */
  private staleTerms = new Map<string, [string, number, number]>();
  private dirtyReads = new Set<number>();
  private dirtyMeta = false;
  private seqAtFlush = 0;

  /** dev: запись в IDB прошла (сколько ключей, мс) — журнал движка */
  onFlush: ((keys: number, ms: number) => void) | null = null;

  private constructor(private db: IDBDatabase, readonly userId: number) {}

  /** Позиции прокрутки чатов (meta «pos:<chatId[:threadId]>»): переживают перезагрузку страницы; нет записи — чат был внизу. */
  async positions(): Promise<Record<string, unknown>> {
    const rows = await getAll<{ k: string; v: unknown }>(this.db, 'meta');
    const out: Record<string, unknown> = {};
    for (const r of rows) if (r.k.startsWith('pos:')) out[r.k.slice(4)] = r.v;
    return out;
  }
  async setPosition(key: string, pos: unknown | null): Promise<void> {
    const os = this.db.transaction('meta', 'readwrite').objectStore('meta');
    if (pos) await req(os.put({ k: 'pos:' + key, v: pos })); else await req(os.delete('pos:' + key));
  }

  static async open(db: IDBDatabase, userId: number): Promise<Store> {
    const s = new Store(db, userId);
    for (const c of await getAll<LocalChat>(db, 'chats')) {
      // строка до отрезков истории: отрезок выведем из сообщений при загрузке чата
      if (!c.ranges) { c.ranges = []; s.legacyRanges.add(c.id); }
      s.chats.set(c.id, c);
    }
    const outbox = (await getAll<OutboxEntry>(db, 'outbox')).sort((a, b) => a.createdAt - b.createdAt);
    for (const o of outbox) s.outbox.set(o.clientId, o);
    for (const r of await getAll<{ chatId: number; upToId: number }>(db, 'pendingReads')) s.pendingReads.set(r.chatId, r.upToId);
    for (const r of await getAll<{ chatId: number; seq: number }>(db, 'chatSeq')) s.chatSeq.set(r.chatId, r.seq);
    const meta = await getAll<{ k: string; v: number }>(db, 'meta');
    s.lastSeq = s.seqAtFlush = meta.find((m) => m.k === 'lastSeq')?.v ?? 0;
    s.since = Number(meta.find((m) => m.k === 'since')?.v ?? 0);
    s.hydrated = !!meta.find((m) => m.k === 'hydrated')?.v;
    s.epoch = ((meta as { k: string; v: unknown }[]).find((m) => m.k === 'epoch')?.v as string) ?? null;
    s.dialogsAt = meta.find((m) => m.k === 'dialogsAt')?.v ?? 0;
    s.dialogsId = meta.find((m) => m.k === 'dialogsId')?.v ?? 0;
    s.dialogsDone = !!meta.find((m) => m.k === 'dialogsDone')?.v;
    s.dialogsTotal = Number(meta.find((m) => m.k === 'dialogsTotal')?.v ?? 0);
    s.profile = await ProfileCache.load(db, userId, meta as { k: string; v: unknown }[]);
    s.contacts = await ContactsCache.load(db, meta as { k: string; v: unknown }[]);
    s.settings = SettingsCache.load(meta as { k: string; v: unknown }[]);
    s.blocks = await BlocksCache.load(db, meta as { k: string; v: unknown }[]);
    s.members = await MembersCache.load(db);
    s.profileLists = await ProfileLists.load(db, meta as { k: string; v: unknown }[]);
    // чаты с неотправленным — сразу в память, чтобы черновики были видны
    for (const chatId of new Set(outbox.map((o) => o.chatId))) await s.loadChatMessages(chatId);
    return s;
  }

  /** Чат известен только по сообщениям: ни собеседника, ни группы — нужен снимок чата с сервера. */
  static unnamed(c: LocalChat): boolean { return c.kind === 'direct' && c.peerId == null && !c.group; }
  unnamed(): number[] { return [...this.chats.values()].filter(Store.unnamed).map((c) => c.id); }

  // ---------- чтение ----------

  isLoaded(chatId: number) { return this.loaded.has(chatId); }

  async loadChatMessages(chatId: number): Promise<void> {
    if (this.loaded.has(chatId)) return;
    const rows = await getByChat(this.db, chatId);
    const map = this.map(chatId);
    for (const m of rows) {
      delete (m as LocalMessage & { tab?: string }).tab;   // поле индекса byTab — только в IndexedDB
      if (!map.has(m.key)) map.set(m.key, m); // не затираем то, что пришло, пока читали
    }
    // правки, пришедшие, пока сообщения были не загружены, — на загруженные строки (в память; запись и слова — обычным путём)
    for (const [rk, rp] of [...this.rowPatches]) {
      if (rp.chatId !== chatId) continue;
      this.rowPatches.delete(rk);
      const old = rows.find((r) => r.id === rp.id);
      if (!old || map.get(old.key) !== old) continue;   // строки нет или в памяти уже новее
      if (rp.drop) {   // удалено, пока чат не был загружен: строку и её слова — прочь
        map.delete(old.key); this.deletedMessages.add(old.key);
        for (const t of termsOf(old)) this.staleTerms.set(termKey(t, old.chatId, old.sort), [t, old.chatId, old.sort]);
        continue;
      }
      const next = { ...old, ...rp.patch };
      map.set(old.key, next);
      this.dirtyMessages.set(old.key, next);
      const now = new Set(termsOf(next));
      for (const t of termsOf(old)) if (!now.has(t)) this.staleTerms.set(`${t}\0${old.chatId}\0${old.sort}`, [t, old.chatId, old.sort]);
    }
    this.loaded.add(chatId);
    this.touch(chatId);
    const chat = this.chats.get(chatId);
    if (chat && this.legacyRanges.delete(chatId)) {
      // прежняя история грузилась только подряд от новых к старым — всё загруженное один отрезок
      const server = this.chatMessages(chatId).filter((m) => m.id != null);
      chat.ranges = server.length ? [[server[0].sort, server[server.length - 1].sort]] : [];
      const old = chat as LocalChat & { historyComplete?: boolean };
      if (old.historyComplete) chat.historyStart = true;
      delete old.historyComplete;
      this.markChat(chat);
    }
  }
  /** Чаты из кэша до отрезков истории (только в памяти, до первой загрузки сообщений). */
  private legacyRanges = new Set<number>();

  /** Сообщения чата по порядку. Массив кэшируется до следующего изменения чата — не мутировать. */
  chatMessages(chatId: number): LocalMessage[] {
    let arr = this.sorted.get(chatId);
    if (!arr) {
      const map = this.messages.get(chatId);
      arr = map ? [...map.values()].sort((a, b) => a.sort - b.sort) : [];
      this.sorted.set(chatId, arr);
    }
    return arr;
  }
  private sorted = new Map<number, LocalMessage[]>();
  private ids = new Map<number, Map<number, LocalMessage>>();
  /** Исходники цитат вне загруженной истории — отдельно, чтобы не рвать непрерывность ленты. В памяти — на случай,
   *  пока строка не прочитана; сами сообщения ложатся и в IndexedDB как вне ленты (addQuotes → addLoose). */
  quotes = new Map<string, QuoteMsg>();
  quoteFor(chatId: number, id: number) { return this.quotes.get(chatId + ':' + id); }
  /** Кто сейчас печатает: chatId → userId. Только в памяти — это состояние момента. */
  typing = new Map<number, Set<number>>();
  setTyping(chatId: number, userId: number, on: boolean): void {
    let set = this.typing.get(chatId);
    if (on) { if (!set) { set = new Set(); this.typing.set(chatId, set); } if (set.has(userId)) return; set.add(userId); }
    else { if (!set?.delete(userId)) return; if (!set.size) this.typing.delete(chatId); }
    this.touch(chatId);
  }

  /** Запросы недостающих цитат копятся здесь; движок забирает их после расчёта подписок. */
  quoteWants = new Map<number, Set<number>>();
  private quoteAsked = new Set<string>();
  wantQuotes(chatId: number, ids: number[]): void {
    for (const id of ids) {
      const k = chatId + ':' + id;
      if (this.quoteAsked.has(k)) continue;
      this.quoteAsked.add(k);
      let set = this.quoteWants.get(chatId);
      if (!set) { set = new Set(); this.quoteWants.set(chatId, set); }
      set.add(id);
    }
  }
  /** Пришедшие исходники цитат: в память и в кэш как сообщения вне ленты (отрезки истории не трогают) —
   *  после перезапуска без сети цитата берётся из сохранённой строки (messageById). Чат уже загружен (см. fetchQuotes).
   *  asked — что спрашивали: сервер не вернул — удалено (или вне видимой истории), цитата «Удалённое сообщение». */
  addQuotes(chatId: number, list: Message[], asked: number[] = []): void {
    for (const m of list) this.quotes.set(chatId + ':' + m.id, toQuote(m as Parameters<typeof toQuote>[0]));
    const got = new Set(list.map((m) => m.id));
    for (const id of asked) if (!got.has(id) && !this.messageById(chatId, id)) this.quotes.set(chatId + ':' + id, deletedQuote(id, 0));
    this.addLoose(chatId, list);
    this.touch(chatId);
  }
  /** Сообщение чата по серверному id (для цитат); индекс строится вместе с отсортированным кэшем. */
  messageById(chatId: number, id: number): LocalMessage | undefined {
    let idx = this.ids.get(chatId);
    if (!idx) { idx = new Map(); for (const m of this.chatMessages(chatId)) if (m.id != null) idx.set(m.id, m); this.ids.set(chatId, idx); }
    return idx.get(id);
  }

  /** Указатель слов отстаёт от памяти: есть незаписанные сообщения, лишние слова или правки строк. */
  get termsDirty(): boolean { return this.dirtyMessages.size > 0 || this.staleTerms.size > 0 || this.rowPatches.size > 0 || this.deletedMessages.size > 0 || this.clearPersistedMessages; }
  /** Сообщение из памяти по ключу строки (новее сохранённой в IDB); нет в памяти — undefined. Удалённое, чья строка ещё
   *  ждёт стирания (до flush), — пометкой deleted: поиск по IDB не найдёт его по старой строке. */
  loadedMessage(chatId: number, key: string): LocalMessage | undefined {
    return this.messages.get(chatId)?.get(key) ?? (this.deletedMessages.has(key) ? { key, chatId, deleted: true } as LocalMessage : undefined);
  }

  // ---------- изменения с сервера ----------

  /** seq — номер записи журнала (нужен профилю, чтобы старая запись не откатила свежий ответ). */
  applyUpdate(u: Update, seq?: number): void {
    switch (u.type) {
      case 'newMessage': {
        this.setTyping(u.message.chatId, u.message.senderId, false); // написал — уже не «печатает»
        const own = this.isOwn(u.message);   // до applyMessage: у своего поста с сервера senderId 0
        this.applyMessage(u.message, true, 'journal');
        if (!own) this.notify(u.message, false);
        return;
      }
      case 'mention': return this.applyMention(u.message, u.threadId);
      case 'reaction': return this.applyReaction(u.chatId, u.id);
      case 'reactionsRead': return this.dropReactions(u.chatId, u.ids);
      case 'readOwn': return this.applyOwnRead(u.chatId, u.upToId);
      case 'readBy': return this.applyPeerRead(u.chatId, u.upToId);
      case 'draft': return this.applyRemoteDraft(u.chatId, u.text, u.at, u.entities);
      case 'messageEdited': return this.patchMessage(u.chatId, u.id, { body: u.body, editedAt: u.editedAt, entities: u.entities ?? [] });
      case 'messageMarkup': return this.patchMessage(u.chatId, u.id, { body: u.body, entities: u.entities ?? [], buttons: u.buttons });
      case 'messageDeleted': return this.removeMessage(u.chatId, u.id);
      case 'reactions': return this.patchMessage(u.chatId, u.id, { reactions: u.reactions });
      case 'reactionCounts': return this.patchMessage(u.chatId, u.id, { reactionCounts: u.counts });
      case 'replies': return this.applyReplies(u.chatId, u.id, { count: u.count, lastId: u.lastId, recent: u.recent });
      case 'readThread': return this.applyThreadRead(u.chatId, u.threadId, u.upToId);
      case 'mediaListened': return this.patchMessage(u.chatId, u.id, { listened: true });
      case 'todoUpdated': return this.patchMessage(u.chatId, u.id, { todo: u.todo, ...(u.editedAt ? { editedAt: u.editedAt } : {}) });
      // опрос: общие итоги — поверх своего (мои голоса и раскрытый ответ викторины остаются)
      case 'pollUpdated': {
        const p = this.messageById(u.chatId, u.id)?.poll;
        if (!p) return;
        return this.patchMessage(u.chatId, u.id, { poll: { ...p, voters: u.voters, counts: u.counts, closed: u.closed, ...(u.correct != null ? { correct: u.correct } : {}), ...(u.solution ? { solution: u.solution } : {}) } });
      }
      case 'pollVoted': {
        const p = this.messageById(u.chatId, u.id)?.poll;
        if (!p) return;
        const { my: _, ...rest } = p;
        return this.patchMessage(u.chatId, u.id, { poll: { ...rest, ...(u.my.length ? { my: u.my } : {}), ...(u.correct != null ? { correct: u.correct } : {}), ...(u.solution ? { solution: u.solution } : {}) } });
      }
      case 'linkPreview': return this.patchMessage(u.chatId, u.id, { link: u.link });
      // копии и размер — поверх того, что уже знаем: имя, миниатюра и ключ файла из события могут отсутствовать
      // (сервер старой сборки слал вложение без текста) — своё не теряем
      case 'attachmentUpdated': return this.patchMessage(u.chatId, u.id, { attachment: { ...(this.messageById(u.chatId, u.id)?.attachment ?? {}), ...u.attachment } as typeof u.attachment });
      case 'userUpdated': return applyUserUpdated(this, u.user, seq);
      case 'contactsChanged': return applyContactsChanged(this, u, seq);
      case 'settingsChanged': this.settings.apply(u.settings, seq); return;
      case 'privacyChanged': this.settings.applyPrivacy(u.rules, seq); return;
      case 'blocksChanged': return applyBlocksChanged(this, u, seq);
      case 'sessionsChanged': this.sessionsRev++; return;
      case 'myStickers': this.stickersRev++; return;
      case 'pins': { const chat = this.chats.get(u.chatId); if (chat) { chat.pinned = u.ids; this.markChat(chat); } return; }
      case 'chatNotify': return this.setMute(u.chatId, u.muteUntil);
      case 'chatFlags': return this.setFlags(u.chatId, u);
      // requests у каждого своё (joinRequests), общая запись его не несёт — не затирать
      // канал: владельца общая запись не несёт (null — подписчикам он не раскрывается); админ знает его из сводки — не затирать
      case 'groupUpdated': {
        const chat = this.chats.get(u.chatId);
        if (chat) {
          const ownerId = u.group.ownerId ?? (chat.kind === 'channel' && chat.me?.admin ? chat.group?.ownerId ?? null : null);
          chat.group = { ...u.group, ownerId, requests: chat.group?.requests ?? 0 };
          this.markChat(chat);
        }
        return;
      }
      case 'joinRequests': { const chat = this.chats.get(u.chatId); if (chat?.group) { chat.group = { ...chat.group, requests: u.requests }; this.markChat(chat); } return; }
      case 'membership': {
        const chat = this.chats.get(u.chatId);
        if (chat) { chat.me = u.me; if (this.previews.has(u.chatId)) this.promote(chat); this.markChat(chat); return; }
        // вступил: чат незнаком, seq — номер журнала чата на момент коммита; строку подтянет движок (seqHints)
        if (u.seq != null && !this.chatSeq.has(u.chatId)) { this.setChatSeq(u.chatId, u.seq); this.seqHints.set(u.chatId, 'new'); }
        return;
      }
      case 'members': return applyMembersUpdate(this, u.chatId, u.upsert, u.remove, seq);
      case 'chatRemoved': return this.removeChat(u.chatId);
    }
  }

  /** Превью канала: чат в памяти без строки списка (previews). Строка сервера (GET /groups/:id) — как строка списка. */
  applyPreview(s: ChatSummary, requested = false): void {
    this.previews.add(s.id);
    this.applyChats([s]);
    const c = this.chats.get(s.id);
    if (c && !!c.requested !== requested) { c.requested = requested; this.markChat(c); }
  }

  /** Превью закрыто, а подписки не было: из памяти целиком (в IndexedDB его и не было). */
  dropPreview(chatId: number): void {
    if (!this.previews.has(chatId)) return;
    for (const k of this.messages.get(chatId)?.keys() ?? []) this.dirtyMessages.delete(k);
    for (const [k, t] of this.staleTerms) if (t[1] === chatId) this.staleTerms.delete(k);
    this.removeChat(chatId);
    this.dirtyChats.delete(chatId);
    this.dirtyChatSeq.delete(chatId);
    this.previews.delete(chatId);
  }

  /**
   * Вступил в канал, пока смотрел превью: теперь это обычный чат. Строка, сообщения и номер журнала уходят в
   * IndexedDB (то, что уже в памяти, — без перезагрузки ленты); непрочитанного нет — вступивший начинает с
   * прочитанного (так же решает сервер). Строку списка движок перечитает (seqHints new: заявки, флаги, точный seq).
   */
  private promote(chat: LocalChat): void {
    this.previews.delete(chat.id);
    delete chat.requested;
    chat.unread = 0;
    chat.lastReadId = Math.max(chat.lastReadId, chat.knownMaxId);
    for (const m of this.messages.get(chat.id)?.values() ?? []) this.dirtyMessages.set(m.key, m);
    this.loaded.add(chat.id);
    if (this.chatSeq.has(chat.id)) this.dirtyChatSeq.add(chat.id);
    this.seqHints.set(chat.id, 'new');
  }

  /** Закреплён / архив / пометка «непрочитанное» (журнал, ответ операции): значение сервера — база. */
  setFlags(chatId: number, f: { pinnedAt: number | null; archived: boolean; unreadMark: boolean; archivedAtId?: number }): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const sameAt = f.archivedAtId == null || (chat.archivedAtId ?? 0) === f.archivedAtId;
    if ((chat.pinnedAt ?? null) === f.pinnedAt && !!chat.archived === f.archived && !!chat.unreadMark === f.unreadMark && sameAt) return;
    chat.pinnedAt = f.pinnedAt; chat.archived = f.archived; chat.unreadMark = f.unreadMark;
    if (f.archivedAtId != null) chat.archivedAtId = f.archivedAtId;
    this.markChat(chat);
  }

  /** Журнал чата: номер, до которого применены его события (только для групп и каналов). */
  setChatSeq(chatId: number, seq: number): void {
    if (this.chatSeq.get(chatId) === seq) return;
    this.chatSeq.set(chatId, seq);
    this.dirtyChatSeq.add(chatId);
  }

  /** Время последней полной сверки по часам сервера (hello/chats now) — следующий since. Назад не двигается. */
  setSince(ms: number): void {
    if (ms <= this.since) return;
    this.since = ms;
    this.dirtyMeta = true;
  }

  /**
   * Лента чата сброшена (chatTooLong: журнал чата подрезан дальше, чем мы знаем): сообщения с сервера стираются из
   * памяти и IndexedDB, отрезки истории — заново; строка списка (last, unread, флаги) остаётся. Неотправленное — тоже.
   */
  async resetChat(chatId: number): Promise<void> {
    const c = this.chats.get(chatId);
    if (!c) return;
    if (!this.loaded.has(chatId)) await this.loadChatMessages(chatId);   // чтобы стереть и те строки, что лежали только в IDB
    const map = this.messages.get(chatId);
    if (map) for (const [k, m] of map) if (m.id != null) {
      map.delete(k); this.dirtyMessages.delete(k); this.deletedMessages.add(k);
      for (const t of termsOf(m)) this.staleTerms.set(termKey(t, chatId, m.sort), [t, chatId, m.sort]);
      this.rowPatches.delete(`${chatId}:${m.id}`);
    }
    this.loaded.delete(chatId);
    c.ranges = []; delete c.historyStart; delete c.snapLast; delete c.seed; delete c.mediaDone; delete c.mediaCounts; delete c.mediaCountsAt; delete c.threads;
    this.resetGen++;   // страницы истории, начатые до сброса, устарели
    this.markChat(c);
  }
  private deletedMessages = new Set<string>();

  /** Уведомления чата (журнал, снимок, ответ операции): значение сервера — база; чата в кэше нет — ждать нечего. */
  setMute(chatId: number, muteUntil: number | null): void {
    const chat = this.chats.get(chatId);
    if (!chat || (chat.muteUntil ?? null) === muteUntil) return;
    chat.muteUntil = muteUntil; this.markChat(chat);
  }

  /** Чат больше не мой (вышел, удалили, группу удалили): из памяти, очереди и IndexedDB вместе с сообщениями. */
  removeChat(id: number): void {
    if (!this.chats.has(id)) return;
    this.chats.delete(id); this.chatV.delete(id); this.messages.delete(id); this.loaded.delete(id); this.members.dropChat(id);
    for (const k of [...this.threadReads.keys()]) if (k.startsWith(id + ':')) { this.threadReads.delete(k); this.pendingThreadReads.delete(k); }
    if (this.chatSeq.delete(id)) this.dirtyChatSeq.add(id);   // вернёмся — чат снова «незнакомый», seq из membership
    this.seqHints.delete(id);
    for (const [k, p] of this.rowPatches) if (p.chatId === id) this.rowPatches.delete(k);
    for (const [k, o] of this.outbox) if (o.chatId === id) { this.outbox.delete(k); this.dirtyOutbox.add(k); }
    if (this.pendingReads.delete(id)) this.dirtyReads.add(id);
    this.dirtyChats.add(id); this.touch(id);
  }

  /** Снимок списка чатов (первый вход или tooLong). */
  applySnapshot(list: ChatSummary[], seq = 0): void {
    const keep = new Set(list.map((c) => c.id));
    for (const c of this.outbox.values()) keep.add(c.chatId);
    for (const id of this.previews) keep.add(id);   // превью — не строка списка, снимок его не касается
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) { this.chats.delete(id); this.chatV.delete(id); this.messages.delete(id); this.loaded.delete(id); this.members.dropChat(id); this.dirtyChats.add(id); this.touch(id); } // dirty → удалится и из IDB
    this.applyChats(list, seq);
  }

  /** Слить пришедшие чаты (страница, «непрочитанные», точечная подгрузка), ничего не удаляя. */
  /** seq — позиция журнала до запроса (см. ProfileCache.applyPeer): собеседники ответа не старее её. */
  applyChats(list: ChatSummary[], seq = 0): void {
    if (!this.hydrated) { this.hydrated = true; this.dirtyMeta = true; }
    for (const s of list) {
      // журнал чата: строка старее того, что мы уже применили push'ами, — устарела целиком (ответ, ушедший до них)
      if (s.kind !== 'direct' && s.seq != null) {
        const local = this.chatSeq.get(s.id);
        if (local == null) this.setChatSeq(s.id, s.seq);
        else if (s.seq < local) continue;
        else if (s.seq > local) this.seqHints.set(s.id, 'ahead');
      }
      const chat = this.ensureChat(s.id);
      chat.kind = s.kind;
      // личный чат хранит только peerId: имя и фото собеседника — в people
      chat.peerId = s.peer?.id ?? null;
      if (s.peer) this.profile.applyPeer(s.peer, seq);
      if (s.peer?.system) chat.system = true; else delete chat.system;
      if (s.draft && (!chat.draft || s.draft.at > chat.draft.at) && !this.pendingDrafts.has(s.id)) chat.draft = s.draft;
      if (s.pinned) chat.pinned = s.pinned;
      if (s.muteUntil !== undefined) chat.muteUntil = s.muteUntil;
      if (s.archived !== undefined) { chat.pinnedAt = s.pinnedAt ?? null; chat.archived = s.archived; chat.unreadMark = !!s.unreadMark; }
      if (s.archivedAtId != null) chat.archivedAtId = s.archivedAtId;
      if (s.group) { chat.group = s.group; chat.me = s.me; }
      if (s.peerReadUpTo && s.peerReadUpTo > chat.peerReadUpTo) this.applyPeerRead(s.id, s.peerReadUpTo);
      chat.lastReadId = Math.max(chat.lastReadId, s.lastReadId);
      chat.unread = s.unread;
      // упоминания: число — сервера (строка списка); известные id старше прочитанного — прочь
      if (s.unreadMentions !== undefined) {
        chat.mentions = s.unreadMentions;
        if (!s.unreadMentions) { delete chat.mentionIds; delete chat.mentionThreads; }
      }
      if (s.unreadReactions !== undefined) {
        chat.reactions = s.unreadReactions;
        if (!s.unreadReactions) delete chat.reactionIds;
      }
      if (s.last) {
        chat.knownMaxId = Math.max(chat.knownMaxId, s.last.id);
        this.applyMessage(s.last, false, 'snapshot');
        // место в списке — как у сервера: удалили последнее — чат опускается к дате предыдущего
        if (chat.last?.id === s.last.id) chat.lastAt = s.last.createdAt;
      } else if (!chat.last && s.sortAt) chat.lastAt = s.sortAt;   // сообщений нет (все удалены) — время сервера
      this.markChat(chat);
    }
  }

  /**
   * Страница истории (GET /chats/:id/messages?before): только данные, без влияния на unread. before — с чего
   * грузили (начало отрезка, null — с новейшего края); страница сливается с этим отрезком. !hasMore — дошли до начала.
   */
  applyHistory(chatId: number, list: Message[], hasMore: boolean, before: number | null, gen?: number): void {
    this.applyPage(chatId, list, hasMore, before, 'older', gen);
  }

  /** Страница истории новее after (?after): закрывает дыру над старым отрезком; !hasMore — дошли до самого нового. */
  applyNewerHistory(chatId: number, list: Message[], hasMore: boolean, after: number, gen?: number): void {
    this.applyPage(chatId, list, hasMore, after, 'newer', gen);
  }

  /** Сбросы серверного состояния (tooLong, смена базы): страница, запрошенная до сброса, отбрасывается. */
  resetGen = 0;

  private applyPage(chatId: number, list: Message[], hasMore: boolean, at: number | null, dir: 'older' | 'newer', gen?: number): void {
    if (gen != null && gen !== this.resetGen) return;   // ответ пришёл после сброса — его отрезок устарел
    for (const m of list) this.applyMessage(m, false, 'none');
    const chat = this.ensureChat(chatId);
    for (const m of list) chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    let lo: number | null = null, hi: number | null = null;
    for (const m of list) { if (lo == null || m.id < lo) lo = m.id; if (hi == null || m.id > hi) hi = m.id; }
    // страница перед seed проверяет живой отрезок вниз: не дотянулась до его начала (своё ниже seed) — проверка дальше
    const verifyFrom = dir === 'older' && at != null && at === chat.seed ? chat.ranges[chat.ranges.length - 1]?.[0] : undefined;
    chat.ranges = addPage(chat.ranges, lo, hi, at, dir, !hasMore);
    if (!hasMore && dir === 'older') chat.historyStart = true;
    if (verifyFrom !== undefined) { if (hasMore && lo != null && lo > verifyFrom) chat.seed = lo; else delete chat.seed; }
    const snap = chat.snapLast?.sort;
    if (snap != null && chat.ranges.some((r) => r[0] <= snap && snap <= r[1])) delete chat.snapLast;
    this.markChat(chat);
  }

  /**
   * Журнал или своё подтверждение новее ждущего snapLast: само оно так и не пришло — между живым отрезком и ним
   * дыра. Новый живой отрезок — от snapLast до пришедшего (seed = snapLast), старый остаётся; иначе — extendLive.
   */
  private extendLive(chat: LocalChat, sort: number, own = false): void {
    const snap = chat.snapLast?.sort, last = chat.ranges[chat.ranges.length - 1];
    if (snap == null || sort <= snap || (last && snap <= last[1])) { extendLive(chat, sort, own); return; }
    chat.ranges.push([snap, sort]); chat.seed = snap;
    delete chat.mediaDone;   // над известным во вкладках теперь дыра — их заново от нового края
    this.placeSnapLast(chat);
  }

  /** Последнее из снимка ждало журнала вне ленты — теперь у него отрезок: в ленту. */
  private placeSnapLast(c: LocalChat): void {
    const m = c.snapLast;
    delete c.snapLast;
    if (m && !m.deleted && !this.messages.get(c.id)?.has(m.key)) this.putMessage(m);   // удалённое, пока ждало, — не в ленту
  }

  /** Чаты, где последнее из снимка ждёт журнала (snapLast), — движок берёт их в начале догонки. */
  /** Только личные чаты: у групп snapLast разрешает журнал чата (syncChat/push) или resetChat, не личная догонка. */
  pendingSnapshots(): Map<number, number> {
    const out = new Map<number, number>();
    for (const c of this.chats.values()) if (c.snapLast && c.kind === 'direct') out.set(c.id, c.snapLast.sort);
    return out;
  }

  /**
   * Догонка журнала закончилась: последнее из снимка, известное до её начала (pending), журнал так и не доставил —
   * между живым отрезком и ним дыра (например, вернулись в группу). Оно начинает свой живой отрезок, старый остаётся.
   */
  settleSnapshots(pending: Map<number, number>): void {
    for (const [id, sort] of pending) {
      const c = this.chats.get(id);
      if (!c || c.snapLast?.sort !== sort) continue;
      const last = c.ranges[c.ranges.length - 1];
      if (!last || sort > last[1]) { c.ranges.push([sort, sort]); c.seed = sort; delete c.mediaDone; }
      this.placeSnapLast(c);
      this.markChat(c);
    }
  }

  /** Сообщения не подряд с историей (страницы вкладок «Медиа» и т. п.): в кэш, но отрезки не трогают — лента их не покажет. */
  addLoose(chatId: number, list: Message[]): void {
    for (const m of list) if (m.chatId === chatId) this.applyMessage(m, false, 'none');
  }

  /** range: journal — продлевает живой отрезок, snapshot — последнее из снимка (snapshotLive), none — отрезки не трогает. */
  private applyMessage(m: Message, countUnread: boolean, range: 'journal' | 'snapshot' | 'none'): void {
    // гость треда (не участник группы обсуждения): строки чата нет и не заводим — только сообщения в памяти и отрезки треда
    const chat = this.isGuest(m.chatId) ? null : this.ensureChat(m.chatId);
    const mine = m.senderId === this.userId;
    const map = this.map(m.chatId);
    const prev = map.get(m.clientId);
    // страница истории или строка списка, запрошенные до удаления, — удалённое не воскрешаем (журнал его уже убрал);
    // пометку удалённой копии поста (шапка треда) — можно
    if (range !== 'journal' && !m.deleted && this.quotes.get(m.chatId + ':' + m.id)?.deleted) return;
    const status = mine && (prev?.status === 'read' || m.id <= (chat?.peerReadUpTo ?? 0)) ? 'read' : 'sent';
    const local: LocalMessage = {
      key: m.clientId, clientId: m.clientId, id: m.id, chatId: m.chatId, senderId: m.senderId,
      body: m.body, replyToId: m.replyToId, createdAt: m.createdAt, status, sort: m.id,
      editedAt: m.editedAt ?? null, deleted: !!m.deleted, reactions: m.reactions ?? prev?.reactions ?? [],
      kind: m.kind ?? 'text', attachment: m.attachment ?? null, entities: m.entities ?? [], ...(m.listened != null ? { listened: m.listened } : {}),
      ...(m.service ? { service: m.service } : null),
      ...(m.todo ? { todo: m.todo } : null),
      ...(m.poll ? { poll: m.poll } : null),
      ...(m.contact ? { contact: m.contact } : null),
      ...(m.geo ? { geo: m.geo } : null),
      ...(m.dice ? { dice: m.dice } : null),
      ...(m.groupId ? { groupId: m.groupId } : null),
      ...(m.fwdFrom ? { fwdFrom: m.fwdFrom } : null),
      ...(m.blocks ? { blocks: m.blocks } : null),
      ...(m.buttons ? { buttons: m.buttons } : null),
      ...(m.sticker ? { sticker: m.sticker } : null),
      ...(m.post ? { post: true } : null),
      ...(m.postAuthor ? { postAuthor: m.postAuthor } : null),
      ...(m.threadId != null ? { threadId: m.threadId } : null),
      ...(m.origin ? { origin: m.origin } : null),
      ...postExtras(m, prev, (c, t) => this.threadReads.get(c + ':' + t)),
      // сервер ещё грузит превью, а у нас оно уже есть (показано в поле ввода) — не прятать его до загрузки
      ...(m.link ? { link: m.link.pending && prev?.link && !prev.link.pending && prev.link.url === m.link.url ? prev.link : m.link } : null),
    };
    if (local.deleted) Object.assign(local, DELETED);   // сервер ещё отдаёт превью, статью и пересылку удалённого
    // кнопка комментариев у поста, пришедшего журналом (журнал replies не несёт): копию в группе обсуждения мы видим
    // своим журналом группы — связываем пост и копию в любом порядке прихода (число придёт событием replies)
    if (m.origin && !local.deleted) {
      // альбом: тред один — у первой копии альбома (у остальных копий своего треда нет)
      let copyId = m.id;
      if (m.groupId) for (const x of this.chatMessages(m.chatId)) if (x.groupId === m.groupId && x.origin && x.id != null && x.id < copyId) copyId = x.id;
      this.copyByPost.set(m.origin.chatId + ':' + m.origin.id, { chatId: m.chatId, copyId });
      const p = this.messageById(m.origin.chatId, m.origin.id);
      if (p && !p.replies && !p.deleted && p.id != null) this.patchMessage(p.chatId, p.id, { replies: this.baseReplies(m.chatId, copyId) });
    } else if (m.post && !local.replies && !local.deleted) {
      const c = this.copyByPost.get(m.chatId + ':' + m.id);
      if (c) local.replies = this.baseReplies(c.chatId, c.copyId);
    }
    if (!chat) {
      if (range === 'journal' && m.threadId != null) this.extendThread(m.chatId, m.threadId, m.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(local)) this.putMessage(local);
      return;
    }
    unreadOnArrival(this, chat, m, countUnread);
    chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    if (range === 'journal') { this.extendLive(chat, m.id); if (m.threadId != null) this.extendThread(m.chatId, m.threadId, m.id); }
    else if (range === 'snapshot' && !snapshotLive(chat, local) && !prev) {
      // ждёт журнала: в ленту (за живым отрезком) не кладём — только в превью чата; доставит журнал или settleSnapshots
      onMessage(this, chat, local, 'added');
      return;
    }
    if (!prev || JSON.stringify(prev) !== JSON.stringify(local)) this.putMessage(local);
    this.markChat(chat);
  }

  /** Ответ на просмотры (channel.ts): число только растёт — запоздалый ответ не опускает уже показанное. */
  applyViews(chatId: number, views: [number, number][]): void {
    for (const [id, n] of views) {
      const m = this.messageById(chatId, id);
      if (m && n > (m.views ?? 0)) this.patchMessage(chatId, id, { views: n });
    }
  }

  private applyOwnRead(chatId: number, upToId: number): void {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.lastReadId) return;
    chat.unread = unreadAfterRead(this, chat, chat.lastReadId, upToId);
    chat.lastReadId = upToId;
    // упоминания основной ленты до upToId прочитаны; дочитал до конца — и те, что знали только числом
    this.dropMentions(chatId, (id, thread) => thread == null && id <= upToId, upToId >= chat.knownMaxId);
    this.markChat(chat);
  }

  // ---------- упоминания и уведомления ----------

  /** Своё ли сообщение: senderId мой или это ответ на моё неотправленное (пост: с сервера senderId 0). */
  private isOwn(m: Message): boolean {
    return m.senderId === this.userId || this.outbox.has(m.clientId) || this.messages.get(m.chatId)?.get(m.clientId)?.senderId === this.userId;
  }

  /** Упоминание меня (личный журнал): «@» +1 и id в очередь «к упоминанию»; уже прочитанное место или повтор — мимо. */
  private applyMention(m: Message, threadId?: number): void {
    const chat = this.chats.get(m.chatId);
    if (!chat) return;   // чат ещё не знаем: число придёт строкой списка
    const read = threadId != null ? this.threadReads.get(m.chatId + ':' + threadId) ?? 0 : chat.lastReadId;
    const ids = chat.mentionIds ?? [];
    if (m.id <= read || ids.includes(m.id)) return;
    ids.push(m.id); ids.sort((a, b) => a - b);
    chat.mentionIds = ids;
    if (threadId != null) (chat.mentionThreads ??= {})[m.id] = threadId;
    chat.mentions = (chat.mentions ?? 0) + 1;
    this.markChat(chat);
    this.notify(m, true, threadId);
  }

  /** Убрать прочитанные/удалённые упоминания; all — и известные только числом (дочитал ленту до конца). */
  private dropMentions(chatId: number, gone: (id: number, threadId: number | undefined) => boolean, all = false): void {
    const chat = this.chats.get(chatId);
    if (!chat || !chat.mentions) return;
    const ids = chat.mentionIds ?? [], threads = chat.mentionThreads ?? {};
    const keep = ids.filter((id) => !gone(id, threads[id]));
    const unknown = all ? 0 : Math.max(0, chat.mentions - ids.length);
    if (keep.length === ids.length && unknown === chat.mentions - ids.length) return;
    for (const id of ids) if (!keep.includes(id)) delete threads[id];
    chat.mentionIds = keep;
    chat.mentions = keep.length + unknown;
    if (!keep.length) { delete chat.mentionIds; delete chat.mentionThreads; }
    this.markChat(chat);
  }

  /** «К упоминанию»: старейшее непрочитанное упоминание чата (и его тред) или null. */
  /** Чужая реакция на моё сообщение: +1 и id в очередь (по возрастанию, без повторов). Число — сервера (строка списка). */
  private applyReaction(chatId: number, id: number): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const ids = chat.reactionIds ?? [];
    if (ids.includes(id)) return;
    // число строки списка могло уже учитывать это сообщение (id тогда не знали): лучше недосчитать, чем удвоить
    const counted = (chat.reactions ?? 0) > ids.length;
    ids.push(id); ids.sort((a, b) => a - b);
    chat.reactionIds = ids;
    chat.reactions = counted ? Math.max(chat.reactions ?? 0, ids.length) : ids.length;
    this.markChat(chat);
  }
  /** Реакции прочитаны: ids — эти (увидел, убрали, удалили), без ids — все. Сервер сказал про id, которых мы не
   *  знали (число пришло строкой списка) — они были среди «известных только числом», число уменьшаем.
   *  knownOnly — удаление сообщения у себя: была ли у него реакция, не знаем, число не трогаем (сервер скажет). */
  dropReactions(chatId: number, ids?: number[], knownOnly = false): void {
    const chat = this.chats.get(chatId);
    if (!chat || !chat.reactions) return;
    if (!ids) { chat.reactions = 0; delete chat.reactionIds; this.markChat(chat); return; }
    const known = chat.reactionIds ?? [], keep = known.filter((x) => !ids.includes(x));
    const unknownGone = knownOnly ? 0 : ids.filter((x) => !known.includes(x)).length;
    if (keep.length === known.length && !unknownGone) return;
    const unknown = Math.max(0, chat.reactions - known.length - unknownGone);
    chat.reactionIds = keep;
    chat.reactions = keep.length + unknown;
    if (!keep.length) delete chat.reactionIds;
    this.markChat(chat);
  }
  /** Самая старая непрочитанная реакция, если известны все id; null — спросить сервер (или нет вовсе). */
  nextReaction(chatId: number): number | null {
    const chat = this.chats.get(chatId);
    if (!chat?.reactionIds?.length || chat.reactionIds.length < (chat.reactions ?? 0)) return null;   // знаем не все — у сервера точнее
    return chat.reactionIds[0];
  }
  /** id с сервера (unread): запомнить, число — не меньше их. */
  setReactionIds(chatId: number, ids: number[], count: number): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.reactionIds = ids.length ? [...ids].sort((a, b) => a - b) : undefined;
    chat.reactions = Math.max(count, ids.length);
    if (!chat.reactions) delete chat.reactionIds;
    this.markChat(chat);
  }

  nextMention(chatId: number): { id: number; threadId?: number } | null {
    const chat = this.chats.get(chatId);
    const id = chat?.mentionIds?.[0];
    if (id == null) return null;
    const threadId = chat!.mentionThreads?.[id];
    return threadId != null ? { id, threadId } : { id };
  }

  /** Уведомления о новых чужих сообщениях и упоминаниях (запрос notifications): одно на сообщение — что пришло первым
   *  (newMessage или mention), то и уведомляет; второе молчит. Только в памяти. */
  notifications: Item[] = [];
  private notifiedIds = new Set<string>();
  private notify(m: Message, mention: boolean, threadId?: number): void {
    if (this.previews.has(m.chatId)) return;   // превью канала: не подписан — не уведомляем
    const k = m.chatId + ':' + m.id;
    if (this.notifiedIds.has(k)) return;
    this.notifiedIds.add(k);
    // альбом (несколько файлов одним пузырём): одно уведомление на альбом, как в Telegram — от первого пришедшего фото
    if (m.groupId && !mention) {
      const ak = m.chatId + ':album:' + m.groupId;
      if (this.notifiedIds.has(ak)) return;
      this.notifiedIds.add(ak);
    }
    if (this.notifiedIds.size > 2000) this.notifiedIds.delete(this.notifiedIds.values().next().value!);
    // тред — и у упоминания, и у простого комментария: клик по уведомлению открывает тред, а не ленту группы
    const thread = threadId ?? m.threadId;
    this.notifications.push({
      key: 'n' + k, chatId: m.chatId, id: m.id, mention, ...(thread != null ? { threadId: thread } : {}),
      senderId: m.senderId, body: m.body, kind: m.kind ?? 'text', createdAt: m.createdAt, attachmentName: m.attachment?.name ?? null,
      ...(m.entities?.length ? { entities: m.entities } : {}), ...(m.service ? { service: m.service } : {}), ...(m.post ? { post: true } : {}),
    });
    if (this.notifications.length > NOTIFY_KEEP) this.notifications.splice(0, this.notifications.length - NOTIFY_KEEP);
    this.touch(m.chatId);
  }

  private applyPeerRead(chatId: number, upToId: number): void {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.peerReadUpTo) return;
    chat.peerReadUpTo = upToId;
    for (const m of this.messages.get(chatId)?.values() ?? []) {
      if (m.senderId === this.userId && m.id != null && m.id <= upToId && m.status !== 'read') this.putMessage({ ...m, status: 'read' });
    }
    // сообщения не загружены — прочитанность видна по chat.last
    if (chat.last && chat.last.senderId === this.userId && chat.last.id != null && chat.last.id <= upToId && chat.last.status !== 'read') onMessage(this, chat, { ...chat.last, status: 'read' }, 'edited', chat.last);
    this.markChat(chat);
  }

  // ---------- локальные действия ----------

  /** Прочтение, сделанное на этом устройстве: сразу гасит счётчик. */
  localRead(chatId: number, upToId: number): boolean {
    const chat = this.chats.get(chatId);
    if (!chat || upToId <= chat.lastReadId) return false;
    this.applyOwnRead(chatId, upToId);
    this.pendingReads.set(chatId, Math.max(this.pendingReads.get(chatId) ?? 0, upToId));
    this.dirtyReads.add(chatId);
    return true;
  }

  readSent(chatId: number, upToId: number): void {
    if ((this.pendingReads.get(chatId) ?? 0) <= upToId) { this.pendingReads.delete(chatId); this.dirtyReads.add(chatId); }
  }

  addPending(o: OutboxEntry): void {
    this.outbox.set(o.clientId, o);
    this.dirtyOutbox.add(o.clientId);
    // комментарий в чат без строки, а треда гостя в памяти нет (wipe, перезапуск): только очередь — строку не заводим,
    // сообщение придёт с краем треда, когда его откроют
    if (o.threadId != null && !this.chats.has(o.chatId) && !this.guests.has(o.chatId)) return;
    if (!this.isGuest(o.chatId)) this.ensureChat(o.chatId);   // свой комментарий гостя — без строки чата
    this.loaded.add(o.chatId);
    this.putMessage({
      key: o.clientId, clientId: o.clientId, id: null, chatId: o.chatId, senderId: this.userId,
      body: o.body, entities: o.entities ?? [], replyToId: o.replyToId, createdAt: new Date(o.createdAt).toISOString(),
      status: o.failed ? 'failed' : 'pending', sort: PENDING_BASE + o.createdAt,
      kind: o.sticker ? 'sticker' : o.todo ? 'todo' : o.poll ? 'poll' : o.special?.contact ? 'contact' : o.special?.geo ? 'geo' : o.special?.dice ? 'dice' : o.attachment ? o.attachment.kind : 'text', ...(o.sticker ? { sticker: o.sticker } : {}), attachment: o.attachment ?? null, ...(o.todo ? { todo: o.todo } : {}), ...(o.poll ? { poll: pendingPoll(o.poll) } : {}), ...(o.special?.contact ? { contact: { userId: o.special.contact.userId, name: o.special.contact.name } } : {}), ...(o.special?.geo ? { geo: o.special.geo } : {}), ...(o.special?.dice ? { dice: { emoji: o.special.dice.emoji, value: 0 } } : {}), progress: o.attachment && !o.attachment.id ? 0 : undefined,
      ...(o.failed && o.error ? { error: o.error } : {}),
      ...(o.groupId ? { groupId: o.groupId } : {}),
      ...(o.fwdFrom ? { fwdFrom: o.fwdFrom } : {}),
      ...(o.link ? { link: o.link } : {}),
      ...(o.blocks ? { blocks: o.blocks } : {}),
      ...(o.threadId != null ? { threadId: o.threadId } : {}),
    });
  }

  ack(clientId: string, id: number, createdAt: string): void {
    const o = this.outbox.get(clientId);
    if (o) { this.outbox.delete(o.clientId); this.dirtyOutbox.add(o.clientId); }
    const chatId = o?.chatId ?? this.findChatOf(clientId);
    if (chatId == null) return;
    const m = this.messages.get(chatId)?.get(clientId);
    // гость треда: строки чата нет — только сообщение и отрезок треда; гость прошлого запуска (в памяти уже ничего) — не заводить чат
    if (this.isGuest(chatId) || (!this.chats.has(chatId) && !m)) {
      if (!m) return;
      this.putMessage({ ...m, id, createdAt, sort: id, status: m.status === 'read' ? 'read' : 'sent' });
      if (m.threadId != null) { this.extendThread(chatId, m.threadId, id, true); this.applyThreadRead(chatId, m.threadId, id); }
      return;
    }
    const chat = this.ensureChat(chatId);
    if (m) this.putMessage({ ...m, id, createdAt, sort: id, status: m.status === 'read' || id <= chat.peerReadUpTo ? 'read' : 'sent' });
    chat.knownMaxId = Math.max(chat.knownMaxId, id);
    this.extendLive(chat, id, true);   // неотправленные — часть живого отрезка
    // свой комментарий: продлевает живой отрезок треда, и тред прочитан до него (сервер так же поднял thread_reads)
    if (m?.threadId != null) { this.extendThread(chatId, m.threadId, id, true); this.applyThreadRead(chatId, m.threadId, id); }
    this.markChat(chat);
  }

  // ---------- треды комментариев (группа обсуждения) ----------

  /** Моя прочитанность тредов: «группа:копия» → до какого id (журнал readThread, своё прочтение, свой комментарий). */
  threadReads = new Map<string, number>();
  /** Неотправленные прочтения тредов («группа:копия» → upToId) — уходят пачкой (движок, flushReads). Только в памяти. */
  pendingThreadReads = new Map<string, number>();
  /** Пост, у которого журнал принёс replies, а в кэше нет copyId (пост без кнопки): движок перечитает его по id. */
  wantPost: (chatId: number, id: number) => void = () => {};

  /** Копии постов, увиденные в группах обсуждения: «канал:пост» → копия (только в памяти). */
  private copyByPost = new Map<string, { chatId: number; copyId: number }>();
  private baseReplies(chatId: number, copyId: number): Replies {
    const read = this.threadReads.get(chatId + ':' + copyId);
    return { copyId, chatId, count: 0, lastId: null, recent: [], ...(read ? { readMaxId: read } : {}) };
  }

  /** Комментарий из журнала или своё подтверждение: живой отрезок треда — только если тред открывали (есть отрезки). */
  private extendThread(chatId: number, threadId: number, sort: number, own = false): void {
    const chat = this.chats.get(chatId);
    const t = chat ? chat.threads?.[threadId] : this.guests.get(chatId)?.threads[threadId];
    if (!t) return;
    extendLive(t, sort, own);
    if (chat) this.markChat(chat); else this.touch(chatId);
  }

  /** Отрезки треда (участника — в строке чата, гостя — в памяти). */
  threadRanges(chatId: number, threadId: number): ThreadRanges | undefined {
    const chat = this.chats.get(chatId);
    return chat ? chat.threads?.[threadId] : this.guests.get(chatId)?.threads[threadId];
  }

  /**
   * Треды гостя: группа обсуждения, где я не участник, но читаю и пишу комментарии как подписчик канала (сервер
   * threads.ts threadAccess). Строки чата нет — группа не попадает в список, журнала группы нет: тред — живой вид
   * (watchThread → threadPush), сообщения и отрезки только в памяти, в IndexedDB не пишутся. Вступил — строка
   * чата появилась (ensureChat): открытые сейчас треды переходят в строку чата (их отрезки живые), остальные забываются.
   */
  guests = new Map<number, { info: ThreadGuest; threads: Record<number, ThreadRanges>; open: Set<number> }>();
  /** Движок подписал (on) или отписал тред гостя. Пока не подписан, события мимо — отрезки при переходе в чат не годятся. */
  guestWatch(chatId: number, threadId: number, on: boolean): void {
    const g = this.guests.get(chatId);
    if (g) { if (on) g.open.add(threadId); else g.open.delete(threadId); }
  }
  isGuest(chatId: number): boolean { return !this.chats.has(chatId) && this.guests.has(chatId); }
  guestInfo(chatId: number): ThreadGuest | null { return this.isGuest(chatId) ? this.guests.get(chatId)!.info : null; }

  /** threadPush: события треда гостя. Новое — в тред (уведомлений нет: гость не участник), правки — как из журнала,
   *  информация группы — в guest. */
  applyGuestPush(chatId: number, items: Update[]): void {
    if (!this.isGuest(chatId)) return;
    for (const u of items) {
      if (u.type === 'newMessage') { if (u.message.chatId === chatId) this.applyMessage(u.message, false, 'journal'); }
      else if (u.type === 'groupUpdated') {
        // группа сменила «только участники», одобрение, название — тред гостя показывает это сразу
        const g = this.guests.get(chatId)!, n = u.group;
        g.info = { ...g.info, title: n.title, username: n.username, joinToSend: !!n.joinToSend, joinApproval: n.joinApproval, slowMode: n.slowMode };
        this.touch(chatId);
      }
      else if (GUEST_UPDATES.has(u.type) && (u as { chatId?: number }).chatId === chatId) this.applyUpdate(u);
    }
  }

  /** Страница треда: шапка (копия) и комментарии — в кэш чата (отрезки ленты группы не трогают), отрезки — треда. */
  applyThreadPage(chatId: number, threadId: number, header: Message | null, list: Message[], hasMore: boolean, at: number | null, dir: 'older' | 'newer', gen?: number, guest?: ThreadGuest | null): void {
    if (gen != null && gen !== this.resetGen) return;
    // ответ гостю (guest) — тред без строки чата; ответ участнику — гость в прошлом (вступил)
    if (guest && !this.chats.has(chatId)) { const g = this.guests.get(chatId); this.guests.set(chatId, { info: guest, threads: g?.threads ?? {}, open: g?.open ?? new Set() }); }
    else if (!guest && this.guests.delete(chatId)) this.touch(chatId);
    if (header) this.applyMessage(header, false, 'none');
    for (const m of list) this.applyMessage(m, false, 'none');
    const chat = this.isGuest(chatId) ? null : this.ensureChat(chatId);
    const threads = chat ? (chat.threads ??= {}) : this.guests.get(chatId)!.threads;
    const t = threads[threadId] ?? (threads[threadId] = { ranges: [] });
    let lo: number | null = null, hi: number | null = null;
    for (const m of list) { if (lo == null || m.id < lo) lo = m.id; if (hi == null || m.id > hi) hi = m.id; }
    t.ranges = addPage(t.ranges, lo, hi, at, dir, !hasMore);
    if (!hasMore && dir === 'older') t.historyStart = true;
    if (chat) this.markChat(chat); else this.touch(chatId);
  }

  /** Событие replies (журнал канала): число, последний и комментаторы; copyId и моя прочитанность — как были. */
  private applyReplies(chatId: number, id: number, r: Pick<Replies, 'count' | 'lastId' | 'recent'>): void {
    const m = this.messageById(chatId, id);
    if (m?.replies) { this.patchMessage(chatId, id, { replies: { ...m.replies, ...r } }); return; }
    if (m) this.wantPost(chatId, id);   // кнопки ещё не было (первый комментарий): copyId знает только история
  }

  /** Тред прочитан до upToId: запомнить и погасить точку на кнопке поста (если пост в кэше). */
  applyThreadRead(chatId: number, threadId: number, upToId: number): void {
    const k = chatId + ':' + threadId;
    if ((this.threadReads.get(k) ?? 0) >= upToId) return;
    this.threadReads.set(k, upToId);
    this.dropMentions(chatId, (id, t) => t === threadId && id <= upToId);   // упоминания треда прочитаны
    const copy = this.messageById(chatId, threadId);
    const channelId = copy?.origin?.chatId ?? this.chats.get(chatId)?.group?.linkedChatId ?? this.guests.get(chatId)?.info.channelId ?? null;
    if (channelId == null) return;
    const post = copy?.origin ? this.messageById(channelId, copy.origin.id) : this.chatMessages(channelId).find((x) => x.replies?.copyId === threadId && x.replies.chatId === chatId);
    if (post?.replies && post.id != null && (post.replies.readMaxId ?? 0) < upToId) this.patchMessage(channelId, post.id, { replies: { ...post.replies, readMaxId: upToId } });
  }

  /** Прочтение треда на этом устройстве: сразу у себя, на сервер — пачкой. Основная лента группы (lastReadId) не трогается. */
  localThreadRead(chatId: number, threadId: number, upToId: number): boolean {
    const k = chatId + ':' + threadId;
    if ((this.threadReads.get(k) ?? 0) >= upToId) return false;
    this.applyThreadRead(chatId, threadId, upToId);
    this.pendingThreadReads.set(k, Math.max(this.pendingThreadReads.get(k) ?? 0, upToId));
    return true;
  }

  /** Сервер отказал (или отправить нечего). error — код отказа (blocked — собеседник заблокировал отправителя). */
  fail(clientId: string, error?: string): void {
    const o = this.outbox.get(clientId);
    if (!o) return;
    o.failed = true;
    if (error) o.error = error; else delete o.error;
    this.dirtyOutbox.add(clientId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) this.putMessage({ ...m, status: 'failed', ...(error ? { error } : {}) });
  }

  unfail(clientId: string): boolean {
    const o = this.outbox.get(clientId);
    if (!o || !o.failed) return false;
    o.failed = false;
    delete o.error;
    this.dirtyOutbox.add(clientId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) { const { error: _e, ...rest } = m; this.putMessage({ ...rest, status: 'pending' }); }
    return true;
  }

  /** dev «Отбросить failed»: неотправленные с отказом — из очереди и из ленты. Строки сообщений в IDB удаляет движок. */
  discardFailed(): string[] {
    return this.discard([...this.outbox.values()].filter((o) => o.failed).map((o) => o.clientId));
  }

  /** Убрать неотправленные (отказ или отмена загрузки) из очереди и из ленты; вернёт те, что были в очереди. */
  discard(clientIds: string[]): string[] {
    const ids: string[] = [];
    for (const clientId of clientIds) {
      const o = this.outbox.get(clientId);
      if (!o) continue;
      ids.push(o.clientId);
      this.outbox.delete(o.clientId);
      this.dirtyOutbox.add(o.clientId);
      this.dirtyMessages.delete(o.clientId);
      this.messages.get(o.chatId)?.delete(o.clientId);
      this.touch(o.chatId);
      const chat = this.chats.get(o.chatId);
      if (chat?.last?.key === o.clientId) recomputeLast(this, chat);
      if (chat) this.markChat(chat);
    }
    return ids;
  }

  /** Файл загружен — вложению неотправленного сообщения есть id (переживёт перезагрузку в outbox). */
  setUploaded(clientId: string, id: string): void {
    const o = this.outbox.get(clientId);
    if (!o?.attachment) return;
    o.attachment = { ...o.attachment, id };
    delete o.upload;
    this.dirtyOutbox.add(clientId);
    this.setProgress(clientId, 1);
  }
  /** Загрузка частями: какие части уже приняты (null — начать заново). */
  setUploadState(clientId: string, up: OutboxEntry['upload'] | null): void {   // null — загрузка закончена, состояние убрать
    const o = this.outbox.get(clientId);
    if (!o) return;
    if (up) o.upload = up; else delete o.upload;
    this.dirtyOutbox.add(clientId);
  }
  /** Прогресс загрузки неотправленного файла (0…1; нет сообщения — 0). */
  progressOf(clientId: string): number {
    const chatId = this.outbox.get(clientId)?.chatId;
    return (chatId != null ? this.messages.get(chatId)?.get(clientId)?.progress : undefined) ?? 0;
  }
  /** Прогресс загрузки файла неотправленного сообщения (в ленте — кольцо). */
  setProgress(clientId: string, p: number): void {
    const chatId = this.outbox.get(clientId)?.chatId;
    const m = chatId != null ? this.messages.get(chatId)?.get(clientId) : undefined;
    if (m) this.putMessage({ ...m, progress: p });
  }

  /**
   * Сообщение удалено (как в Telegram — исчезает целиком): из памяти и IndexedDB вместе со словами поиска, из
   * упоминаний и уведомлений; цитаты на него — «Удалённое сообщение». Отрезки истории — интервалы id: дыра на его
   * месте им не мешает. Непрочитанное чужое — минус из unread. Было последним — последним становится предыдущее из
   * памяти (onMessage); нет такого — строку чата спросим у сервера (wantRow).
   * Копия поста в группе обсуждения (origin) остаётся пометкой deleted: шапка её треда — «Пост удалён», а лента группы
   * удалённое не показывает (queries.ts).
   */
  private removeMessage(chatId: number, id: number): void {
    this.dropMentions(chatId, (x) => x === id);
    this.dropReactions(chatId, [id], true);
    const k = chatId + ':' + id, m = this.messageById(chatId, id), q = this.quotes.get(k);
    // цитата знает о нём и без запроса к серверу (сервер удалённое больше не отдаёт); автор нужен только для цвета полосы
    if (!q?.deleted) { this.quotes.set(k, deletedQuote(id, m?.senderId ?? q?.senderId ?? 0)); this.touch(chatId); }
    const n = this.notifications.length;
    this.notifications = this.notifications.filter((x) => !(x.chatId === chatId && x.id === id));
    if (this.notifications.length !== n) this.touch(chatId);
    const chat = this.chats.get(chatId);
    if (!chat) {
      // гость треда: сообщения только в памяти — комментарий убрать, копию поста (шапку) — пометкой «Пост удалён»
      if (m && !m.deleted && this.isGuest(chatId)) {
        if (m.origin) this.putMessage({ ...m, ...DELETED });
        else { this.messages.get(chatId)!.delete(m.key); this.touch(chatId); }
      }
      return;
    }
    // последнее из снимка ждало журнала — журнал дошёл до него (удаление на его месте): до него всё подряд, дыры нет
    if (chat.snapLast?.id === id) { extendLive(chat, chat.snapLast.sort); delete chat.snapLast; this.markChat(chat); }
    if (!m) {
      this.rowPatches.set(k, { chatId, id, patch: { ...DELETED }, drop: true });   // строка могла остаться в IDB
      const last = chat.last;
      if (last?.id === id) {   // и пометка из старого кэша: превью — предыдущее
        if (!last.deleted && last.senderId !== this.userId && id > chat.lastReadId && chat.unread > 0) chat.unread--;
        onMessage(this, chat, { ...last, ...DELETED }, 'deleted', last);
        return;
      }
      // чьё оно — не знаем: непрочитанное (новее прочитанного) — счётчик возьмём у сервера
      if (id > chat.lastReadId && chat.unread > 0) this.wantRow(chatId);
      if (chat.mediaCounts && id <= (chat.mediaCountsAt ?? 0)) { delete chat.mediaCounts; delete chat.mediaCountsAt; this.markChat(chat); }   // могло быть во вкладке — спросим заново
      return;
    }
    if (m.deleted) return;   // уже пометка (копия поста)
    if (m.senderId !== this.userId && id > chat.lastReadId && chat.unread > 0) chat.unread--;
    if (m.origin) { this.putMessage({ ...m, ...DELETED }); return; }
    const map = this.messages.get(chatId)!;
    map.delete(m.key); this.dirtyMessages.delete(m.key); this.deletedMessages.add(m.key);
    for (const t of termsOf(m)) this.staleTerms.set(termKey(t, chatId, m.sort), [t, chatId, m.sort]);
    this.rowPatches.delete(k);
    this.touch(chatId);
    onMessage(this, chat, { ...m, ...DELETED }, 'deleted', m);   // last, счётчики вкладок, строка списка
  }
  /** Строке чата нужен свежий снимок с сервера (последнее удалили, а предыдущего в кэше нет); движок спросит /chats?ids. */
  wantRow: (chatId: number) => void = () => {};

  /** Правка/реакции загруженного сообщения (и превью последнего сообщения чата). Незагруженное — придёт с историей. */
  patchMessage(chatId: number, id: number, patch: Partial<LocalMessage>): void {
    const m = this.messageById(chatId, id);
    if (m) { this.putMessage({ ...m, ...patch }); return; }
    if (this.isGuest(chatId)) return;   // гость: в IndexedDB ничего нет — править нечего
    const rk = `${chatId}:${id}`, prevP = this.rowPatches.get(rk);
    // в IDB строка могла остаться — поправим при записи (с её словами); уже удалённую (drop) правка не воскрешает
    this.rowPatches.set(rk, { ...prevP, chatId, id, patch: { ...prevP?.patch, ...patch } });
    const chat0 = this.chats.get(chatId);
    if (chat0?.snapLast?.id === id) { chat0.snapLast = { ...chat0.snapLast, ...patch }; this.markChat(chat0); }   // ждёт журнала — правка не теряется
    // сообщение не загружено — правится только превью последнего
    const chat = this.chats.get(chatId);
    if (chat?.last && chat.last.id === id) { onMessage(this, chat, { ...chat.last, ...patch }, patch.deleted && !chat.last.deleted ? 'deleted' : 'edited', chat.last); return; }
    // правка или удаление неизвестного: могло быть во вкладке — счётчики спросим заново
    if (chat?.mediaCounts && id <= (chat.mediaCountsAt ?? 0) && ('body' in patch || 'deleted' in patch)) { delete chat.mediaCounts; delete chat.mediaCountsAt; this.markChat(chat); }
  }

  /** Черновики, ещё не отправленные на сервер (правки этого устройства). */
  pendingDrafts = new Set<number>();

  /** Черновик с другого устройства (журнал) или из снимка: локальный неотправленный и более новый — главнее. */
  applyRemoteDraft(chatId: number, text: string, at: string, entities?: Entity[]): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    if (this.pendingDrafts.has(chatId) && chat.draft && chat.draft.at > at) return;
    const next = text ? { text, at, ...(entities?.length ? { entities } : {}) } : null;
    if (sameDraft(chat.draft, next)) return;
    chat.draft = next;
    this.markChat(chat);
  }

  /** Черновик чата: пустой текст — удалить. false — ничего не изменилось (тот же текст). */
  setDraft(chatId: number, text: string, entities?: Entity[]): boolean {
    const chat = this.chats.get(chatId);
    if (!chat) return false;
    const next = text.trim() ? { text, at: new Date().toISOString(), ...(entities?.length ? { entities } : {}) } : null;
    if (sameDraft(chat.draft, next)) return false;
    chat.draft = next;
    this.markChat(chat);
    return true;
  }

  /** Сервер пересоздал базу (другое поколение): выбросить всё — чаты, сообщения, очередь, указатели — и IDB тоже. */
  async wipe(epoch: string | null, keep: { outbox?: boolean } = {}): Promise<void> {
    // «оставить неотправленное»: очередь отправки, её файлы, очередь операций и неотправленные прочтения
    // (KEEP_STORES) переживают очистку
    const saved = keep.outbox ? [...this.outbox.values()] : [];
    const reads = keep.outbox ? new Map(this.pendingReads) : new Map<number, number>();
    this.resetGen++;
    for (const id of this.chats.keys()) this.touch(id);
    this.chats.clear(); this.chatV.clear(); this.messages.clear(); this.loaded.clear(); this.sorted.clear(); this.ids.clear(); this.guests.clear();
    this.outbox.clear(); this.pendingReads.clear(); this.profile.reset(); this.contacts.reset(); this.settings.reset(); this.blocks.reset(); this.members.reset(); this.profileLists.reset();
    this.dirtyChats.clear(); this.dirtyMessages.clear(); this.dirtyOutbox.clear(); this.dirtyReads.clear();
    this.rowPatches.clear();
    this.quotes.clear(); this.quoteAsked.clear(); this.quoteWants.clear();   // цитаты старого кэша — спросим заново
    this.lastSeq = this.seqAtFlush = 0;
    this.chatSeq.clear(); this.dirtyChatSeq.clear(); this.seqHints.clear(); this.since = 0;   // хранилище chatSeq стирается вместе с кэшем
    this.previews.clear();
    this.hydrated = false;
    this.dialogsAt = 0; this.dialogsId = 0; this.dialogsDone = false;
    this.pendingDrafts.clear();   // черновики жили в стёртых чатах: пустой текст на сервер не отправляем
    this.epoch = epoch;
    const db = this.db as IDBDatabase;
    const names = keep.outbox ? [...CACHE_STORES, 'outbox'] : STORES;   // outbox — заново из saved (с сообщениями ленты)
    const t = db.transaction(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
    for (const o of saved) this.addPending(o);
    for (const [c, up] of reads) { this.pendingReads.set(c, up); this.dirtyReads.add(c); }
    this.dirtyMeta = true;
    await this.flush();
  }

  markMeta(): void { this.dirtyMeta = true; }

  /** Куда дошла подгрузка диалогов. next = null — страниц больше нет. */
  setDialogsCursor(next: { at: string; id: number } | null, total?: number): void {
    if (total != null) this.dialogsTotal = total;
    this.dialogsAt = next ? Date.parse(next.at) : 0;
    this.dialogsId = next ? next.id : 0;
    this.dialogsDone = !next;
    this.dirtyMeta = true;
  }

  /** Страницы диалогов — заново (tooLong): чаты без неотправленного забываем, курсор в начало. */
  resetDialogs(): void {
    const keep = new Set([...this.outbox.values()].map((o) => o.chatId));
    for (const id of this.previews) keep.add(id);
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) { this.chats.delete(id); this.chatV.delete(id); this.messages.delete(id); this.loaded.delete(id); this.members.dropChat(id); this.dirtyChats.add(id); this.touch(id); } // dirty → удалится и из IDB
    this.dialogsAt = 0; this.dialogsId = 0; this.dialogsDone = false;
    this.rowPatches.clear();
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }

  /** tooLong: забыть всё серверное, оставив неотправленное. */
  resetForSnapshot(): void {
    this.resetGen++;
    for (const chatId of [...this.chats.keys()]) {
      const map = this.messages.get(chatId);
      if (map) for (const [k, m] of map) if (m.id != null) { map.delete(k); }
      const c = this.chats.get(chatId)!;
      c.unread = 0; c.knownMaxId = 0; c.ranges = []; delete c.historyStart; delete c.snapLast; delete c.seed; delete c.threads; c.last = null;
      delete c.mediaCounts; delete c.mediaCountsAt; delete c.mediaDone;
      this.markChat(c);
    }
    this.lastSeq = 0;
    for (const id of this.chatSeq.keys()) this.dirtyChatSeq.add(id);
    this.chatSeq.clear(); this.seqHints.clear(); this.since = 0;   // ленты групп стёрты вместе со всеми — номера возьмутся из строк снимка
    this.rowPatches.clear();
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }
  private clearPersistedMessages = false;

  // ---------- сохранение ----------

  async flush(): Promise<void> {
    const t0 = Date.now();
    // правка в памяти новее запоздавшей правки строки — её пропускаем
    const live = new Set<string>();
    for (const m of this.dirtyMessages.values()) if (m.id != null) live.add(`${m.chatId}:${m.id}`);
    const batch: WriteBatch = { put: {}, del: {}, rowPatches: [...this.rowPatches].filter(([k]) => !live.has(k)).map(([, v]) => v) };
    this.rowPatches.clear();
    if (this.clearPersistedMessages) {
      // сообщения удаляются отдельной транзакцией до записи новых
      const t = (this.db as IDBDatabase).transaction(['messages', 'terms'], 'readwrite');
      t.objectStore('messages').clear(); t.objectStore('terms').clear();
      await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      this.clearPersistedMessages = false;
      this.staleTerms.clear();
      for (const map of this.messages.values()) for (const m of map.values()) this.dirtyMessages.set(m.key, m);
    }
    // чат, который сейчас урезает уборка, ждёт: его строку пишет транзакция уборки, а в памяти отрезки ещё шире
    const held = [...this.dirtyChats].filter((id) => this.trimming.has(id) && this.chats.has(id));
    // превью каналов (previews) — только в памяти: ни строки, ни сообщений, ни слов, ни номера журнала
    const kept = (chatId: number) => !this.previews.has(chatId);
    batch.put.chats = [...this.dirtyChats].filter((id) => !this.trimming.has(id) && kept(id)).map((id) => this.chats.get(id)).filter(Boolean) as LocalChat[];
    batch.del.chats = [...this.dirtyChats].filter((id) => !this.chats.has(id));
    // основная вкладка «Общих медиа» (mediaTab, первая из tabsOf) — поле индекса byTab; в памяти его нет
    batch.put.messages = [...this.dirtyMessages.values()].filter((m) => kept(m.chatId)).map((m) => { const tab = tabsOf(m)[0]; return tab ? { ...m, tab } : m; });
    if (this.deletedMessages.size) { batch.del.messages = [...this.deletedMessages]; this.deletedMessages.clear(); }
    batch.put.chatSeq = [...this.dirtyChatSeq].filter((id) => this.chatSeq.has(id) && kept(id)).map((chatId) => ({ chatId, seq: this.chatSeq.get(chatId)! }));
    batch.del.chatSeq = [...this.dirtyChatSeq].filter((id) => !this.chatSeq.has(id));
    this.dirtyChatSeq.clear();
    // указатель слов — в той же транзакции; в IDB только подтверждённые сервером (у неотправленных sort меняется при ack)
    const termRows: { term: string; chatId: number; sort: number; key: string }[] = [];
    const fresh = new Set<string>();
    for (const m of this.dirtyMessages.values()) if (kept(m.chatId)) for (const term of termsOf(m)) { termRows.push({ term, chatId: m.chatId, sort: m.sort, key: m.key }); fresh.add(termKey(term, m.chatId, m.sort)); }
    batch.put.terms = termRows;
    batch.del.terms = [...this.staleTerms].filter(([k]) => !fresh.has(k)).map(([, v]) => v);
    this.staleTerms.clear();
    batch.put.outbox = [...this.dirtyOutbox].map((k) => this.outbox.get(k)).filter(Boolean) as OutboxEntry[];
    batch.del.outbox = [...this.dirtyOutbox].filter((k) => !this.outbox.has(k));
    batch.put.pendingReads = [...this.dirtyReads].filter((c) => this.pendingReads.has(c)).map((c) => ({ chatId: c, upToId: this.pendingReads.get(c) }));
    batch.del.pendingReads = [...this.dirtyReads].filter((c) => !this.pendingReads.has(c));
    if (this.dirtyMeta || this.lastSeq !== this.seqAtFlush) batch.put.meta = [{ k: 'lastSeq', v: this.lastSeq }, { k: 'since', v: this.since }, { k: 'hydrated', v: this.hydrated ? 1 : 0 }, { k: 'dialogsAt', v: this.dialogsAt }, { k: 'dialogsId', v: this.dialogsId }, { k: 'dialogsDone', v: this.dialogsDone ? 1 : 0 }, { k: 'dialogsTotal', v: this.dialogsTotal }, ...(this.epoch ? [{ k: 'epoch', v: this.epoch as unknown as number }] : [])];
    const prof = this.profile.collect();
    if (prof.me) batch.put.meta = [...(batch.put.meta ?? []), prof.me];
    batch.put.users = prof.users;
    batch.del.users = prof.del;
    const contacts = this.contacts.collect();
    batch.put.contacts = contacts.put;
    batch.del.contacts = contacts.del;
    if (contacts.meta.length) batch.put.meta = [...(batch.put.meta ?? []), ...contacts.meta];
    const settings = this.settings.collect();
    if (settings) batch.put.meta = [...(batch.put.meta ?? []), settings];
    const blocks = this.blocks.collect();
    batch.put.blocked = blocks.put;
    batch.del.blocked = blocks.del;
    if (blocks.meta.length) batch.put.meta = [...(batch.put.meta ?? []), ...blocks.meta];
    const members = this.members.collect();
    batch.put.members = members.put;
    batch.del.members = members.del;
    const lists = this.profileLists.collect();
    batch.put.profileMusic = lists.music.put;
    batch.del.profileMusic = lists.music.del;
    batch.put.profilePhotos = lists.photos.put;
    batch.del.profilePhotos = lists.photos.del;
    if (lists.meta) batch.put.meta = [...(batch.put.meta ?? []), lists.meta];
    this.dirtyChats.clear(); this.dirtyMessages.clear(); this.dirtyOutbox.clear(); this.dirtyReads.clear(); this.dirtyMeta = false;
    for (const id of held) this.dirtyChats.add(id);   // запишется следующим flush, уже сжатой
    const seq = this.lastSeq;
    await write(this.db, batch);
    this.seqAtFlush = seq;
    if (this.onFlush) {
      let keys = 0;
      for (const v of Object.values(batch.put)) keys += v?.length ?? 0;
      for (const v of Object.values(batch.del)) keys += v?.length ?? 0;
      if (keys) this.onFlush(keys, Date.now() - t0);
    }
  }

  // ---------- внутреннее ----------

  private map(chatId: number): Map<string, LocalMessage> {
    let m = this.messages.get(chatId);
    if (!m) { m = new Map(); this.messages.set(chatId, m); }
    return m;
  }

  private ensureChat(id: number): LocalChat {
    let c = this.chats.get(id);
    if (!c) {
      c = { id, kind: 'direct', lastReadId: 0, unread: 0, knownMaxId: 0, peerReadUpTo: 0, ranges: [], peerId: null, last: null, lastAt: new Date(0).toISOString() };
      // вступил в группу обсуждения: открытые треды гостя (живые отрезки) — в строку чата, их сообщения — в IndexedDB
      const g = this.guests.get(id);
      if (g) {
        this.guests.delete(id);
        for (const t of g.open) if (g.threads[t]) (c.threads ??= {})[t] = g.threads[t];
        for (const m of this.messages.get(id)?.values() ?? []) this.dirtyMessages.set(m.key, m);
      }
      this.chats.set(id, c);
      this.markChat(c);
    }
    return c;
  }

  private putMessage(m: LocalMessage): void {
    const map = this.map(m.chatId), prev = map.get(m.key);
    map.set(m.key, m);
    if (this.isGuest(m.chatId)) { this.touch(m.chatId); return; }   // гость треда: только память (ни IndexedDB, ни строки чата)
    this.dirtyMessages.set(m.key, m);
    if (prev) { const now = new Set(termsOf(m)); for (const t of termsOf(prev)) if (!now.has(t) || prev.sort !== m.sort) this.staleTerms.set(termKey(t, prev.chatId, prev.sort), [t, prev.chatId, prev.sort]); }
    const chat = this.ensureChat(m.chatId);
    this.touch(m.chatId);   // отсортированная лента устарела — derive может её читать
    onMessage(this, chat, m, !prev ? 'added' : m.deleted && !prev.deleted ? 'deleted' : 'edited', prev);
  }

  /** Версии строк чатов (только в памяти, общий счётчик rows.nextV): подпись строки списка. */
  private chatV = new Map<number, number>();
  chatVersion(id: number): number {
    let v = this.chatV.get(id);
    if (v == null) { v = nextV(); this.chatV.set(id, v); }   // чат из IDB, ещё не менялся
    return v;
  }

  /** Ленту чата открыли: для уборки (evict.ts) — давно не открытые урезаются первыми. Строку списка не трогает. */
  noteOpened(chatId: number): void {
    const c = this.chats.get(chatId);
    if (c) { c.openedAt = Date.now(); this.dirtyChats.add(chatId); }
  }

  /** Строка чата изменилась вне строки списка (отрезки после уборки): в IDB и ленте, версия списка прежняя. */
  saveChat(c: LocalChat): void { this.dirtyChats.add(c.id); this.touch(c.id); }

  /**
   * Уборка (evict.ts) уже стёрла эти строки и их слова в IDB: из памяти тоже, вместе с отложенными правками строк.
   * Строку, изменившуюся в памяти после стирания (ждёт записи), не трогаем — flush запишет её заново.
   */
  dropMessages(chatId: number, list: { key: string; id: number | null }[]): void {
    const map = this.messages.get(chatId);
    for (const { key, id } of list) {
      if (id != null) this.rowPatches.delete(`${chatId}:${id}`);
      if (map && !this.dirtyMessages.has(key)) map.delete(key);
    }
    if (list.length) { this.trims.set(chatId, this.trimGen(chatId) + 1); this.touch(chatId); }
  }
  /** Чаты, порцию которых сейчас стирает уборка (evict.ts): flush не пишет их строку, пока память не сжата. */
  trimming = new Set<number>();
  /** Сколько раз уборка стирала сообщения чата (только в памяти): страница, начатая до уборки, не пишет курсоры поверх стёртого. */
  trimGen(chatId: number): number { return this.trims.get(chatId) ?? 0; }
  private trims = new Map<number, number>();

  markChat(c: LocalChat): void {
    this.dirtyChats.add(c.id);
    this.chatV.set(c.id, nextV());
    this.touch(c.id);
  }

  /** Строка чата в подписках пересчитается (название зависит не только от самого чата). */
  retouch(chatId: number): void { this.touch(chatId); }
  private touch(chatId: number): void { this.touched.add(chatId); this.sorted.delete(chatId); this.ids.delete(chatId); }

  private findChatOf(clientId: string): number | null {
    for (const [chatId, map] of this.messages) if (map.has(clientId)) return chatId;
    return null;
  }
}
const termKey = (term: string, chatId: number, sort: number) => `${term}\0${chatId}\0${sort}`;
