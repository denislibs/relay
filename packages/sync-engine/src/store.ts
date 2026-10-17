import type { Message, Update } from '@relay/protocol';
import { getAll, getByChat, write, type WriteBatch } from './idb';
import { applyUserUpdated, ProfileCache } from './profile';
import { applyContactsChanged, ContactsCache } from './contacts';
import { SettingsCache } from './settings';
import { applyBlocksChanged, BlocksCache } from './blocks';
import { PENDING_BASE, type LocalChat, type LocalMessage, type OutboxEntry } from './types';

export interface ChatSummary {
  draft?: { text: string; at: string } | null;
  sortAt?: string;
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  lastReadId: number;
  unread: number;
  last: Message | null;
  peer?: { id: number; name: string } | null;
  peerReadUpTo?: number;
}

/**
 * Доменное состояние в памяти воркера. Каждое изменение помечает грязные записи;
 * `flush()` пишет их в IDB одной транзакцией вместе с lastSeq.
 * Сообщения чата держатся в памяти только для загруженных чатов (`loadChatMessages`);
 * у остальных чатов в памяти лишь последнее сообщение (`chat.last`).
 */
export class Store {
  chats = new Map<number, LocalChat>();
  outbox = new Map<string, OutboxEntry>();
  pendingReads = new Map<number, number>();
  lastSeq = 0;
  /** снимок с сервера уже лежит в кэше (иначе показывать нечего — идёт первая загрузка) */
  hydrated = false;
  /** Поколение базы сервера, с которым синхронизирован кэш. */
  epoch: string | null = null;
  /** Подгрузка диалогов страницами: курсор следующей страницы (время в мс + id) и «дальше пусто». */
  dialogsAt = 0;
  dialogsId = 0;
  dialogsDone = false;
  /** чаты, изменившиеся с последнего прохода подписок */
  touched = new Set<number>();
  /** свой профиль и кэш чужих (profile.ts) */
  profile!: ProfileCache;
  /** контакты (contacts.ts) */
  contacts!: ContactsCache;
  /** настройки аккаунта (settings.ts) */
  settings!: SettingsCache;
  /** чёрный список (blocks.ts) */
  blocks!: BlocksCache;
  /** название чата для списка; движок подставляет контактное имя с учётом очереди операций */
  titleOf: (c: LocalChat) => string | null = (c) => c.title;

  private messages = new Map<number, Map<string, LocalMessage>>();
  private loaded = new Set<number>();
  private dirtyChats = new Set<number>();
  private dirtyMessages = new Map<string, LocalMessage>();
  private dirtyOutbox = new Set<string>();
  private dirtyReads = new Set<number>();
  private dirtyMeta = false;
  private seqAtFlush = 0;

  /** dev: запись в IDB прошла (сколько ключей, мс) — журнал движка */
  onFlush: ((keys: number, ms: number) => void) | null = null;

  private constructor(private db: IDBDatabase, readonly userId: number) {}

  static async open(db: IDBDatabase, userId: number): Promise<Store> {
    const s = new Store(db, userId);
    for (const c of await getAll<LocalChat>(db, 'chats')) s.chats.set(c.id, c);
    const outbox = (await getAll<OutboxEntry>(db, 'outbox')).sort((a, b) => a.createdAt - b.createdAt);
    for (const o of outbox) s.outbox.set(o.clientId, o);
    for (const r of await getAll<{ chatId: number; upToId: number }>(db, 'pendingReads')) s.pendingReads.set(r.chatId, r.upToId);
    const meta = await getAll<{ k: string; v: number }>(db, 'meta');
    s.lastSeq = s.seqAtFlush = meta.find((m) => m.k === 'lastSeq')?.v ?? 0;
    s.hydrated = !!meta.find((m) => m.k === 'hydrated')?.v;
    s.epoch = ((meta as { k: string; v: unknown }[]).find((m) => m.k === 'epoch')?.v as string) ?? null;
    s.dialogsAt = meta.find((m) => m.k === 'dialogsAt')?.v ?? 0;
    s.dialogsId = meta.find((m) => m.k === 'dialogsId')?.v ?? 0;
    s.dialogsDone = !!meta.find((m) => m.k === 'dialogsDone')?.v;
    s.profile = await ProfileCache.load(db, userId, meta as { k: string; v: unknown }[]);
    s.contacts = ContactsCache.load(meta as { k: string; v: unknown }[]);
    s.settings = SettingsCache.load(meta as { k: string; v: unknown }[]);
    s.blocks = BlocksCache.load(meta as { k: string; v: unknown }[]);
    // чаты с неотправленным — сразу в память, чтобы черновики были видны
    for (const chatId of new Set(outbox.map((o) => o.chatId))) await s.loadChatMessages(chatId);
    return s;
  }

  /** чаты, известные только по сообщениям: им нужно название со снимка */
  unnamed(): number[] { return [...this.chats.values()].filter((c) => !c.named).map((c) => c.id); }

  // ---------- чтение ----------

  isLoaded(chatId: number) { return this.loaded.has(chatId); }

  async loadChatMessages(chatId: number): Promise<void> {
    if (this.loaded.has(chatId)) return;
    const rows = await getByChat(this.db, chatId);
    const map = this.map(chatId);
    for (const m of rows) if (!map.has(m.key)) map.set(m.key, m); // не затираем то, что пришло, пока читали
    this.loaded.add(chatId);
    this.touch(chatId);
  }

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
  /** Исходники цитат вне загруженной истории — отдельно, чтобы не рвать непрерывность ленты. Только в памяти. */
  quotes = new Map<string, { id: number; sort: number; body: string; senderId: number }>();
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
  addQuotes(chatId: number, list: Message[]): void {
    for (const m of list) this.quotes.set(chatId + ':' + m.id, { id: m.id, sort: m.id, body: m.body, senderId: m.senderId });
    this.touch(chatId);
  }
  /** Сообщение чата по серверному id (для цитат); индекс строится вместе с отсортированным кэшем. */
  messageById(chatId: number, id: number): LocalMessage | undefined {
    let idx = this.ids.get(chatId);
    if (!idx) { idx = new Map(); for (const m of this.chatMessages(chatId)) if (m.id != null) idx.set(m.id, m); this.ids.set(chatId, idx); }
    return idx.get(id);
  }

  oldestId(chatId: number): number | null {
    for (const m of this.chatMessages(chatId)) if (m.id != null) return m.id;
    return null;
  }

  // ---------- изменения с сервера ----------

  /** seq — номер записи журнала (нужен профилю, чтобы старая запись не откатила свежий ответ). */
  applyUpdate(u: Update, seq?: number): void {
    switch (u.type) {
      case 'newMessage':
        this.setTyping(u.message.chatId, u.message.senderId, false); // написал — уже не «печатает»
        return this.applyMessage(u.message, true);
      case 'readOwn': return this.applyOwnRead(u.chatId, u.upToId);
      case 'readBy': return this.applyPeerRead(u.chatId, u.upToId);
      case 'draft': return this.applyRemoteDraft(u.chatId, u.text, u.at);
      case 'messageEdited': return this.patchMessage(u.chatId, u.id, { body: u.body, editedAt: u.editedAt });
      case 'messageDeleted': return this.patchMessage(u.chatId, u.id, { body: '', deleted: true, reactions: [] });
      case 'reactions': return this.patchMessage(u.chatId, u.id, { reactions: u.reactions });
      case 'userUpdated': return applyUserUpdated(this, u.user, seq);
      case 'contactsChanged': return applyContactsChanged(this, u, seq);
      case 'settingsChanged': this.settings.apply(u.settings, seq); return;
      case 'privacyChanged': this.settings.applyPrivacy(u.rules, seq); return;
      case 'blocksChanged': return applyBlocksChanged(this, u, seq);
    }
  }

  /** Снимок списка чатов (первый вход или tooLong). */
  applySnapshot(list: ChatSummary[]): void {
    const keep = new Set(list.map((c) => c.id));
    for (const c of this.outbox.values()) keep.add(c.chatId);
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) { this.chats.delete(id); this.messages.delete(id); this.loaded.delete(id); this.dirtyChats.add(id); this.touch(id); } // dirty → удалится и из IDB
    this.applyChats(list);
  }

  /** Слить пришедшие чаты (страница, «непрочитанные», точечная подгрузка), ничего не удаляя. */
  applyChats(list: ChatSummary[]): void {
    if (!this.hydrated) { this.hydrated = true; this.dirtyMeta = true; }
    for (const s of list) {
      const chat = this.ensureChat(s.id);
      chat.kind = s.kind;
      chat.title = s.title ?? s.peer?.name ?? null;
      chat.peerId = s.peer?.id ?? null;
      if (s.draft && (!chat.draft || s.draft.at > chat.draft.at) && !this.pendingDrafts.has(s.id)) chat.draft = s.draft;
      chat.named = true;
      if (s.peerReadUpTo && s.peerReadUpTo > chat.peerReadUpTo) this.applyPeerRead(s.id, s.peerReadUpTo);
      chat.lastReadId = Math.max(chat.lastReadId, s.lastReadId);
      chat.unread = s.unread;
      if (s.last) {
        chat.knownMaxId = Math.max(chat.knownMaxId, s.last.id);
        this.applyMessage(s.last, false);
      }
      this.markChat(chat);
    }
  }

  /** Страница истории: только данные, без влияния на unread. */
  applyHistory(chatId: number, list: Message[], hasMore: boolean): void {
    for (const m of list) this.applyMessage(m, false);
    const chat = this.ensureChat(chatId);
    for (const m of list) chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    if (!hasMore) chat.historyComplete = true;
    this.markChat(chat);
  }

  private applyMessage(m: Message, countUnread: boolean): void {
    const chat = this.ensureChat(m.chatId);
    const mine = m.senderId === this.userId;
    const map = this.map(m.chatId);
    const prev = map.get(m.clientId);
    const status = mine && (prev?.status === 'read' || m.id <= chat.peerReadUpTo) ? 'read' : 'sent';
    const local: LocalMessage = {
      key: m.clientId, clientId: m.clientId, id: m.id, chatId: m.chatId, senderId: m.senderId,
      body: m.body, replyToId: m.replyToId, createdAt: m.createdAt, status, sort: m.id,
      editedAt: m.editedAt ?? null, deleted: !!m.deleted, reactions: m.reactions ?? prev?.reactions ?? [],
      kind: m.kind ?? 'text', attachment: m.attachment ?? null,
    };
    if (countUnread && !mine && m.id > chat.lastReadId && m.id > chat.knownMaxId) chat.unread++;
    chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(local)) this.putMessage(local);
    this.markChat(chat);
  }

  private applyOwnRead(chatId: number, upToId: number): void {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.lastReadId) return;
    chat.unread = this.unreadAfterRead(chat, chat.lastReadId, upToId);
    chat.lastReadId = upToId;
    this.markChat(chat);
  }

  private applyPeerRead(chatId: number, upToId: number): void {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.peerReadUpTo) return;
    chat.peerReadUpTo = upToId;
    for (const m of this.messages.get(chatId)?.values() ?? []) {
      if (m.senderId === this.userId && m.id != null && m.id <= upToId && m.status !== 'read') this.putMessage({ ...m, status: 'read' });
    }
    if (chat.last && chat.last.senderId === this.userId && chat.last.id != null && chat.last.id <= upToId) chat.last = { ...chat.last, status: 'read' };
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
    this.ensureChat(o.chatId);
    this.loaded.add(o.chatId);
    this.putMessage({
      key: o.clientId, clientId: o.clientId, id: null, chatId: o.chatId, senderId: this.userId,
      body: o.body, replyToId: o.replyToId, createdAt: new Date(o.createdAt).toISOString(),
      status: o.failed ? 'failed' : 'pending', sort: PENDING_BASE + o.createdAt,
      kind: o.attachment ? o.attachment.kind : 'text', attachment: o.attachment ?? null, progress: o.attachment && !o.attachment.id ? 0 : undefined,
      ...(o.failed && o.error ? { error: o.error } : {}),
    });
  }

  ack(clientId: string, id: number, createdAt: string): void {
    const o = this.outbox.get(clientId);
    if (o) { this.outbox.delete(o.clientId); this.dirtyOutbox.add(o.clientId); }
    const chatId = o?.chatId ?? this.findChatOf(clientId);
    if (chatId == null) return;
    const chat = this.ensureChat(chatId);
    const m = this.messages.get(chatId)?.get(clientId);
    if (m) this.putMessage({ ...m, id, createdAt, sort: id, status: m.status === 'read' || id <= chat.peerReadUpTo ? 'read' : 'sent' });
    chat.knownMaxId = Math.max(chat.knownMaxId, id);
    this.markChat(chat);
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
    const ids: string[] = [];
    for (const o of [...this.outbox.values()]) {
      if (!o.failed) continue;
      ids.push(o.clientId);
      this.outbox.delete(o.clientId);
      this.dirtyOutbox.add(o.clientId);
      this.dirtyMessages.delete(o.clientId);
      const map = this.messages.get(o.chatId);
      map?.delete(o.clientId);
      const chat = this.chats.get(o.chatId);
      if (chat?.last?.key === o.clientId) {
        let last: LocalMessage | null = null;
        for (const m of map?.values() ?? []) if (!last || m.sort > last.sort) last = m;
        chat.last = last;
      }
      if (chat) this.markChat(chat); else this.touch(o.chatId);
    }
    return ids;
  }

  /** Файл загружен — вложению неотправленного сообщения есть id (переживёт перезагрузку в outbox). */
  setUploaded(clientId: string, id: string): void {
    const o = this.outbox.get(clientId);
    if (!o?.attachment) return;
    o.attachment = { ...o.attachment, id };
    this.dirtyOutbox.add(clientId);
    this.setProgress(clientId, 1);
  }
  /** Прогресс загрузки файла неотправленного сообщения (в ленте — кольцо). */
  setProgress(clientId: string, p: number): void {
    const chatId = this.outbox.get(clientId)?.chatId;
    const m = chatId != null ? this.messages.get(chatId)?.get(clientId) : undefined;
    if (m) this.putMessage({ ...m, progress: p });
  }

  /** Правка/удаление/реакции загруженного сообщения (и превью последнего сообщения чата). Незагруженное — придёт с историей. */
  patchMessage(chatId: number, id: number, patch: Partial<LocalMessage>): void {
    const m = this.messageById(chatId, id);
    if (m) this.putMessage({ ...m, ...patch });
    const chat = this.chats.get(chatId);
    if (chat?.last && chat.last.id === id) { chat.last = { ...chat.last, ...patch }; this.markChat(chat); }
  }

  /** Черновики, ещё не отправленные на сервер (правки этого устройства). */
  pendingDrafts = new Set<number>();

  /** Черновик с другого устройства (журнал) или из снимка: локальный неотправленный и более новый — главнее. */
  applyRemoteDraft(chatId: number, text: string, at: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    if (this.pendingDrafts.has(chatId) && chat.draft && chat.draft.at > at) return;
    const next = text ? { text, at } : null;
    if ((chat.draft?.text ?? null) === (next?.text ?? null)) return;
    chat.draft = next;
    this.markChat(chat);
  }

  /** Черновик чата: пустой текст — удалить. false — ничего не изменилось (тот же текст). */
  setDraft(chatId: number, text: string): boolean {
    const chat = this.chats.get(chatId);
    if (!chat) return false;
    const next = text.trim() ? { text, at: new Date().toISOString() } : null;
    if ((chat.draft?.text ?? null) === (next?.text ?? null)) return false;
    chat.draft = next;
    this.markChat(chat);
    return true;
  }

  /** Сервер пересоздал базу (другое поколение): выбросить всё — чаты, сообщения, очередь, указатели — и IDB тоже. */
  async wipe(epoch: string | null, keep: { outbox?: boolean } = {}): Promise<void> {
    // «оставить неотправленное»: очередь отправки, её файлы и очередь операций переживают очистку
    const saved = keep.outbox ? [...this.outbox.values()] : [];
    for (const id of this.chats.keys()) this.touch(id);
    this.chats.clear(); this.messages.clear(); this.loaded.clear(); this.sorted.clear(); this.ids.clear();
    this.outbox.clear(); this.pendingReads.clear(); this.profile.reset(); this.contacts.reset(); this.settings.reset(); this.blocks.reset();
    this.dirtyChats.clear(); this.dirtyMessages.clear(); this.dirtyOutbox.clear(); this.dirtyReads.clear();
    this.lastSeq = this.seqAtFlush = 0;
    this.hydrated = false;
    this.dialogsAt = 0; this.dialogsId = 0; this.dialogsDone = false;
    this.pendingDrafts.clear();   // черновики жили в стёртых чатах: пустой текст на сервер не отправляем
    this.epoch = epoch;
    const db = this.db as IDBDatabase;
    const names = keep.outbox ? ['chats', 'messages', 'outbox', 'pendingReads', 'meta', 'users'] : ['chats', 'messages', 'outbox', 'pendingReads', 'meta', 'users', 'ops', 'blobs'];
    const t = db.transaction(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
    for (const o of saved) this.addPending(o);
    this.dirtyMeta = true;
    await this.flush();
  }

  markMeta(): void { this.dirtyMeta = true; }

  /** Куда дошла подгрузка диалогов. next = null — страниц больше нет. */
  setDialogsCursor(next: { at: string; id: number } | null): void {
    this.dialogsAt = next ? Date.parse(next.at) : 0;
    this.dialogsId = next ? next.id : 0;
    this.dialogsDone = !next;
    this.dirtyMeta = true;
  }

  /** Страницы диалогов — заново (tooLong): чаты без неотправленного забываем, курсор в начало. */
  resetDialogs(): void {
    const keep = new Set([...this.outbox.values()].map((o) => o.chatId));
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) { this.chats.delete(id); this.messages.delete(id); this.loaded.delete(id); this.dirtyChats.add(id); this.touch(id); } // dirty → удалится и из IDB
    this.dialogsAt = 0; this.dialogsId = 0; this.dialogsDone = false;
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }

  /** tooLong: забыть всё серверное, оставив неотправленное. */
  resetForSnapshot(): void {
    for (const chatId of [...this.chats.keys()]) {
      const map = this.messages.get(chatId);
      if (map) for (const [k, m] of map) if (m.id != null) { map.delete(k); }
      const c = this.chats.get(chatId)!;
      c.unread = 0; c.knownMaxId = 0; c.historyComplete = false; c.last = null;
      this.markChat(c);
    }
    this.lastSeq = 0;
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }
  private clearPersistedMessages = false;

  // ---------- сохранение ----------

  async flush(): Promise<void> {
    const t0 = Date.now();
    const batch: WriteBatch = { put: {}, del: {} };
    if (this.clearPersistedMessages) {
      // сообщения удаляются отдельной транзакцией до записи новых
      const t = (this.db as IDBDatabase).transaction('messages', 'readwrite');
      t.objectStore('messages').clear();
      await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      this.clearPersistedMessages = false;
      for (const map of this.messages.values()) for (const m of map.values()) this.dirtyMessages.set(m.key, m);
    }
    batch.put.chats = [...this.dirtyChats].map((id) => this.chats.get(id)).filter(Boolean) as LocalChat[];
    batch.del.chats = [...this.dirtyChats].filter((id) => !this.chats.has(id));
    batch.put.messages = [...this.dirtyMessages.values()];
    batch.put.outbox = [...this.dirtyOutbox].map((k) => this.outbox.get(k)).filter(Boolean) as OutboxEntry[];
    batch.del.outbox = [...this.dirtyOutbox].filter((k) => !this.outbox.has(k));
    batch.put.pendingReads = [...this.dirtyReads].filter((c) => this.pendingReads.has(c)).map((c) => ({ chatId: c, upToId: this.pendingReads.get(c) }));
    batch.del.pendingReads = [...this.dirtyReads].filter((c) => !this.pendingReads.has(c));
    if (this.dirtyMeta || this.lastSeq !== this.seqAtFlush) batch.put.meta = [{ k: 'lastSeq', v: this.lastSeq }, { k: 'hydrated', v: this.hydrated ? 1 : 0 }, { k: 'dialogsAt', v: this.dialogsAt }, { k: 'dialogsId', v: this.dialogsId }, { k: 'dialogsDone', v: this.dialogsDone ? 1 : 0 }, ...(this.epoch ? [{ k: 'epoch', v: this.epoch as unknown as number }] : [])];
    const prof = this.profile.collect();
    if (prof.me) batch.put.meta = [...(batch.put.meta ?? []), prof.me];
    if (prof.users.length) batch.put.users = prof.users;
    const contacts = this.contacts.collect();
    if (contacts) batch.put.meta = [...(batch.put.meta ?? []), contacts];
    const settings = this.settings.collect();
    if (settings) batch.put.meta = [...(batch.put.meta ?? []), settings];
    const blocks = this.blocks.collect();
    if (blocks) batch.put.meta = [...(batch.put.meta ?? []), blocks];
    this.dirtyChats.clear(); this.dirtyMessages.clear(); this.dirtyOutbox.clear(); this.dirtyReads.clear(); this.dirtyMeta = false;
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
      c = { id, kind: 'direct', title: null, lastReadId: 0, unread: 0, knownMaxId: 0, peerReadUpTo: 0, historyComplete: false, peerId: null, named: false, last: null, lastAt: new Date(0).toISOString() };
      this.chats.set(id, c);
      this.markChat(c);
    }
    return c;
  }

  private putMessage(m: LocalMessage): void {
    this.map(m.chatId).set(m.key, m);
    this.dirtyMessages.set(m.key, m);
    const chat = this.ensureChat(m.chatId);
    if (!chat.last || chat.last.key === m.key || m.sort >= chat.last.sort) {
      chat.last = m;
      if (m.createdAt > chat.lastAt) chat.lastAt = m.createdAt;
    }
    this.markChat(chat);
  }

  markChat(c: LocalChat): void {
    this.dirtyChats.add(c.id);
    this.touch(c.id);
  }

  /** Строка чата в подписках пересчитается (название зависит не только от самого чата). */
  retouch(chatId: number): void { this.touch(chatId); }
  private touch(chatId: number): void { this.touched.add(chatId); this.sorted.delete(chatId); this.ids.delete(chatId); }

  /** Дочитали до конца — 0; иначе вычитаем известные чужие сообщения из прочитанного диапазона (from, to]. */
  private unreadAfterRead(chat: LocalChat, from: number, to: number): number {
    if (to >= chat.knownMaxId) return 0;
    let n = 0;
    for (const m of this.messages.get(chat.id)?.values() ?? []) {
      if (m.senderId !== this.userId && m.id != null && m.id > from && m.id <= to) n++;
    }
    return Math.max(0, chat.unread - n);
  }

  private findChatOf(clientId: string): number | null {
    for (const [chatId, map] of this.messages) if (map.has(clientId)) return chatId;
    return null;
  }
}
