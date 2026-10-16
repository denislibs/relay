import type { Message, Update } from '@relay/protocol';
import { getAll, getByChat, write, type WriteBatch } from './idb';
import { PENDING_BASE, type LocalChat, type LocalMessage, type OutboxEntry } from './types';

export interface ChatSummary {
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
  /** чаты, изменившиеся с последнего прохода подписок */
  touched = new Set<number>();

  private messages = new Map<number, Map<string, LocalMessage>>();
  private loaded = new Set<number>();
  private dirtyChats = new Set<number>();
  private dirtyMessages = new Map<string, LocalMessage>();
  private dirtyOutbox = new Set<string>();
  private dirtyReads = new Set<number>();
  private dirtyMeta = false;
  private seqAtFlush = 0;

  private constructor(private db: IDBDatabase, readonly userId: number) {}

  static async open(db: IDBDatabase, userId: number): Promise<Store> {
    const s = new Store(db, userId);
    for (const c of await getAll<LocalChat>(db, 'chats')) s.chats.set(c.id, c);
    const outbox = (await getAll<OutboxEntry>(db, 'outbox')).sort((a, b) => a.createdAt - b.createdAt);
    for (const o of outbox) s.outbox.set(o.clientId, o);
    for (const r of await getAll<{ chatId: number; upToId: number }>(db, 'pendingReads')) s.pendingReads.set(r.chatId, r.upToId);
    const meta = await getAll<{ k: string; v: number }>(db, 'meta');
    s.lastSeq = s.seqAtFlush = meta.find((m) => m.k === 'lastSeq')?.v ?? 0;
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

  chatMessages(chatId: number): LocalMessage[] {
    const map = this.messages.get(chatId);
    return map ? [...map.values()].sort((a, b) => a.sort - b.sort) : [];
  }

  oldestId(chatId: number): number | null {
    for (const m of this.chatMessages(chatId)) if (m.id != null) return m.id;
    return null;
  }

  // ---------- изменения с сервера ----------

  applyUpdate(u: Update): void {
    switch (u.type) {
      case 'newMessage': return this.applyMessage(u.message, true);
      case 'readOwn': return this.applyOwnRead(u.chatId, u.upToId);
      case 'readBy': return this.applyPeerRead(u.chatId, u.upToId);
    }
  }

  /** Снимок списка чатов (первый вход или tooLong). */
  applySnapshot(list: ChatSummary[]): void {
    const keep = new Set(list.map((c) => c.id));
    for (const c of this.outbox.values()) keep.add(c.chatId);
    for (const id of [...this.chats.keys()]) if (!keep.has(id)) { this.chats.delete(id); this.messages.delete(id); this.loaded.delete(id); this.touch(id); }
    for (const s of list) {
      const chat = this.ensureChat(s.id);
      chat.kind = s.kind;
      chat.title = s.title ?? s.peer?.name ?? null;
      chat.peerId = s.peer?.id ?? null;
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

  fail(clientId: string): void {
    const o = this.outbox.get(clientId);
    if (!o) return;
    o.failed = true;
    this.dirtyOutbox.add(clientId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) this.putMessage({ ...m, status: 'failed' });
  }

  unfail(clientId: string): boolean {
    const o = this.outbox.get(clientId);
    if (!o || !o.failed) return false;
    o.failed = false;
    this.dirtyOutbox.add(clientId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) this.putMessage({ ...m, status: 'pending' });
    return true;
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
    if (this.dirtyMeta || this.lastSeq !== this.seqAtFlush) batch.put.meta = [{ k: 'lastSeq', v: this.lastSeq }];
    this.dirtyChats.clear(); this.dirtyMessages.clear(); this.dirtyOutbox.clear(); this.dirtyReads.clear(); this.dirtyMeta = false;
    const seq = this.lastSeq;
    await write(this.db, batch);
    this.seqAtFlush = seq;
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

  private markChat(c: LocalChat): void {
    this.dirtyChats.add(c.id);
    this.touch(c.id);
  }

  private touch(chatId: number): void { this.touched.add(chatId); }

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
