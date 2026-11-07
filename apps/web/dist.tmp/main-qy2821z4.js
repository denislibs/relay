import {
  FOLDER_LIMITS,
  normalizeFolder,
  normalizeFolders,
  FILE_CHUNK,
  importFileKey,
  newFileKey,
  newNonceBase,
  sealedSource,
  toBase64,
  fromBase64,
  SAVED_GIFS_LIMIT,
  SAVED_TITLE,
  RECENT_STICKERS_LIMIT,
  FAVED_STICKERS_LIMIT,
  savedPeerRule,
  draftHash,
  MEDIA_TABS,
  isVideoMedia,
  mediaTabs,
  MAX_FILE_BYTES,
  PRIVACY_KEYS,
  defaultPrivacy,
  searchTerms,
  signDevice,
  deviceFetch,
  OP_SESSIONS_TTL,
  Sessions2,
  canPost,
  shiftCounts,
  ViewCounter,
  cleanName,
  cleanText
} from "./main-p1twxvxz.js";

// packages/sync-engine/src/rows.ts
var clock = 0;
var nextV = () => ++clock;
function sameContent(a, b) {
  const ka = Object.keys(a).filter((k) => k !== "seq" && k !== "v");
  const kb = Object.keys(b).filter((k) => k !== "seq" && k !== "v");
  if (ka.length !== kb.length)
    return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y)
      continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null)
      return false;
    if (JSON.stringify(x) !== JSON.stringify(y))
      return false;
  }
  return true;
}

class Table {
  rows = new Map;
  dirty = new Set;
  removed = new Set;
  get(k) {
    return this.rows.get(k);
  }
  put(k, value, seq) {
    const prev = this.rows.get(k);
    if (prev && seq < prev.seq)
      return false;
    if (prev && sameContent(prev, value)) {
      prev.seq = seq;
      return false;
    }
    this.rows.set(k, { ...value, seq, v: nextV() });
    this.dirty.add(k);
    this.removed.delete(k);
    return true;
  }
  delete(k) {
    const had = this.rows.delete(k);
    this.removed.add(k);
    this.dirty.delete(k);
    return had;
  }
  collect() {
    const put = [];
    for (const k of this.dirty) {
      const row = this.rows.get(k);
      if (!row)
        continue;
      const { v: _v, ...rest } = row;
      put.push(rest);
    }
    const del = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    return { put, del };
  }
  clear() {
    this.rows.clear();
    this.dirty.clear();
    this.removed.clear();
  }
  load(list, key) {
    for (const item of list)
      this.rows.set(key(item), { ...item, seq: item.seq ?? 0, v: nextV() });
  }
}

// packages/sync-engine/src/contacts.ts
var OP_CONTACT = "contact:";
var contactKey = (userId) => OP_CONTACT + userId;
var contactIdOf = (key) => key.startsWith(OP_CONTACT) ? Number(key.slice(OP_CONTACT.length)) || null : null;
var contactName = (c) => `${c.firstName} ${c.lastName}`.trim();
function baseOf(c) {
  const { seq: _seq, ...rest } = c;
  return rest;
}

class ContactsCache {
  table = new Table;
  loaded = false;
  dirty = false;
  version = 0;
  changedIds = new Map;
  gone = new Map;
  floor = 0;
  persist = false;
  static async load(db, meta) {
    const c = new ContactsCache;
    c.table.load(await getAll(db, "contacts"), (x) => x.userId);
    c.floor = meta.find((m) => m.k === "contactsFloor")?.v ?? 0;
    c.loaded = !!meta.find((m) => m.k === "contactsLoaded")?.v;
    return c;
  }
  seqOf(id) {
    return Math.max(this.table.get(id)?.seq ?? this.gone.get(id) ?? 0, this.floor);
  }
  touch() {
    this.dirty = true;
    this.version++;
  }
  before(id, prev) {
    if (!this.changedIds.has(id))
      this.changedIds.set(id, prev);
  }
  applyContact(c, seq = c.seq) {
    if (seq !== undefined && seq <= this.seqOf(c.userId))
      return false;
    const prev = this.table.get(c.userId);
    this.gone.delete(c.userId);
    if (this.table.put(c.userId, baseOf(c), seq ?? prev?.seq ?? 0)) {
      this.before(c.userId, prev);
      this.touch();
    }
    return true;
  }
  applyRemoved(userId, seq) {
    if (seq !== undefined && seq <= this.seqOf(userId))
      return false;
    if (seq !== undefined)
      this.gone.set(userId, seq);
    const prev = this.table.get(userId);
    if (!prev)
      return true;
    this.before(userId, prev);
    this.table.delete(userId);
    this.touch();
    return true;
  }
  applySnapshot(list, seq) {
    const ids = new Set(list.map((c) => c.userId));
    let changed = !this.loaded;
    for (const c of list)
      if (seq >= this.seqOf(c.userId)) {
        const prev = this.table.get(c.userId);
        this.gone.delete(c.userId);
        if (this.table.put(c.userId, baseOf(c), seq)) {
          if (!prev || contactName(prev) !== contactName(c))
            this.before(c.userId, prev);
          changed = true;
        }
      }
    for (const [id, prev] of [...this.table.rows])
      if (!ids.has(id) && seq >= this.seqOf(id)) {
        this.before(id, prev);
        this.table.delete(id);
        this.gone.set(id, seq);
        changed = true;
      }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.persist = true;
    if (changed)
      this.touch();
  }
  takeChanged() {
    const r = this.changedIds;
    this.changedIds = new Map;
    return r;
  }
  collect() {
    const { put, del } = this.table.collect();
    const meta = this.persist ? [{ k: "contactsFloor", v: this.floor }, { k: "contactsLoaded", v: this.loaded ? 1 : 0 }] : [];
    this.persist = false;
    return { put, del, meta };
  }
  reset() {
    this.table.clear();
    this.gone.clear();
    this.changedIds.clear();
    this.floor = 0;
    this.loaded = false;
    this.persist = true;
    this.touch();
  }
}
function contactsView(base, ops, users) {
  const view = new Map;
  for (const [id, c] of base)
    view.set(id, { ...c, pending: false });
  for (const op of ops) {
    const id = contactIdOf(op.key);
    if (!id)
      continue;
    const prev = view.get(id);
    const b = op.body ?? {};
    if (op.method === "DELETE") {
      view.delete(id);
      continue;
    }
    if (op.method === "POST") {
      const user = prev?.user ?? users.get(id) ?? { id, name: "", firstName: "", lastName: "", username: null, bio: null, birthday: null, phone: null, links: [] };
      view.set(id, {
        userId: id,
        firstName: cleanName(b.firstName ?? ""),
        lastName: cleanName(b.lastName ?? ""),
        note: b.note !== undefined ? cleanText(b.note) : prev?.note ?? "",
        user,
        presence: prev?.presence,
        pending: true
      });
    } else if (op.method === "PATCH" && prev) {
      view.set(id, {
        ...prev,
        firstName: b.firstName !== undefined ? cleanName(b.firstName) : prev.firstName,
        lastName: b.lastName !== undefined ? cleanName(b.lastName ?? "") : prev.lastName,
        note: b.note !== undefined ? cleanText(b.note ?? "") : prev.note,
        pending: true
      });
    }
  }
  return view;
}
function contactItems(view, users, presence) {
  const out = [];
  for (const c of view.values()) {
    const u = users.get(c.userId) ?? c.user;
    const p = presence.get(c.userId) ?? c.presence ?? null;
    out.push({
      key: "k" + c.userId,
      userId: c.userId,
      firstName: c.firstName,
      lastName: c.lastName,
      note: c.note,
      name: contactName(c) || u.publicName || u.name,
      publicName: u.publicName ?? c.user.publicName ?? null,
      username: u.username,
      phone: u.phone,
      birthday: u.birthday ?? null,
      online: p?.online ?? false,
      lastSeen: p?.lastSeen ?? null,
      known: !!p,
      pending: c.pending,
      photo: u.photo ?? null
    });
  }
  return out;
}
function applyContactsChanged(store, u, seq) {
  if (u.contact) {
    if (store.contacts.applyContact(u.contact, seq))
      store.profile.applyUser(u.contact.user);
  } else if (u.removed) {
    if (store.contacts.applyRemoved(u.removed, seq) && u.user)
      store.profile.applyUser(u.user);
  }
}
class Contacts {
  h;
  memo = null;
  constructor(h) {
    this.h = h;
  }
  get cache() {
    return this.h.store.contacts;
  }
  view() {
    const m = this.memo, c = this.cache, ops = this.h.ops.list;
    if (m && m.version === c.version && m.ops === ops)
      return m.view;
    const view = contactsView(c.table.rows, ops, this.h.store.profile.users.rows);
    this.memo = { version: c.version, ops, view };
    return view;
  }
  publicName(id, was) {
    return this.h.store.profile.users.get(id)?.publicName ?? was?.user.publicName ?? null;
  }
  items() {
    const c = this.cache;
    const list = c.loaded || this.h.ops.list.some((o) => contactIdOf(o.key)) ? contactItems(this.view(), this.h.store.profile.users.rows, this.h.presence()) : [];
    list.push({ key: "~contacts", loaded: c.loaded });
    return list;
  }
  repair() {
    const store = this.h.store;
    for (const [id, was] of this.cache.takeChanged()) {
      if (this.cache.table.get(id))
        continue;
      const pub = this.publicName(id, was);
      const u = store.profile.users.get(id);
      if (u && pub && u.name !== pub) {
        const sp = pub.indexOf(" ");
        store.profile.applyUser({ ...u, name: pub, firstName: sp < 0 ? pub : pub.slice(0, sp), lastName: sp < 0 ? "" : pub.slice(sp + 1) });
      }
      this.h.refreshUser(id);
    }
  }
  take(c) {
    this.h.store.profile.applyUser(c.user);
    if (c.presence)
      this.h.seedPresence(c.userId, c.presence);
  }
  fetch() {
    this.h.run(async () => {
      const r = await this.h.http("/contacts");
      this.cache.applySnapshot(r.contacts, r.seq);
      for (const c of r.contacts)
        if (this.cache.table.get(c.userId))
          this.take(c);
      this.repair();
      await this.h.store.flush();
      this.h.changed();
    });
  }
  opDone(op, value) {
    const cid = contactIdOf(op.key);
    if (!cid)
      return false;
    if (value && typeof value === "object") {
      const v = value;
      if (v.removed === cid) {
        if (this.cache.applyRemoved(cid, v.seq) && v.user)
          this.h.store.profile.applyUser(v.user);
      } else if (v.userId === cid && this.cache.applyContact(v)) {
        this.take(v);
      }
      this.repair();
      this.h.run(() => this.h.store.flush());
    }
    return true;
  }
  async act(a) {
    const ops = this.h.ops;
    switch (a.type) {
      case "addContact":
        await ops.enqueue({ key: contactKey(a.userId), method: "POST", path: "/contacts", body: { userId: a.userId, ...a.query !== undefined ? { query: a.query } : {}, firstName: a.firstName, lastName: a.lastName ?? "", ...a.note !== undefined ? { note: a.note } : {} } });
        return null;
      case "updateContact": {
        if (!this.view().has(a.userId))
          return null;
        const patch = {};
        for (const k of ["firstName", "lastName", "note"])
          if (a[k] !== undefined)
            patch[k] = a[k];
        if (!Object.keys(patch).length)
          return null;
        const key = contactKey(a.userId);
        const post = [...ops.list].reverse().find((o) => o.key === key);
        if (post?.method === "POST")
          await ops.enqueue({ key, method: "POST", path: "/contacts", body: { ...post.body, ...patch } });
        else
          await ops.enqueue({ key, method: "PATCH", path: `/contacts/${a.userId}`, body: patch });
        return null;
      }
      case "removeContact":
        await ops.enqueue({ key: contactKey(a.userId), method: "DELETE", path: `/contacts/${a.userId}` });
        return null;
      case "resolveUser": {
        if (!this.h.online())
          return { offline: true };
        let res;
        try {
          res = await (this.h.fetch ?? fetch)(`${this.h.httpBase}/users/resolve`, { method: "POST", headers: { "content-type": "application/json", ...this.h.headers ?? {} }, credentials: "include", body: JSON.stringify({ query: a.query }) });
        } catch {
          return { offline: true };
        }
        if (res.status === 404)
          return { notFound: true };
        if (!res.ok)
          return { offline: true };
        const u = await res.json();
        this.h.store.profile.applyUser(u);
        this.h.run(() => this.h.store.flush());
        return { user: u };
      }
    }
  }
}

// packages/sync-engine/src/names.ts
function contactOf(store, userId) {
  const c = store.contactOf(userId);
  if (!c)
    return null;
  return { name: contactName(c), v: store.contacts.table.get(userId)?.v ?? 0, pending: "pending" in c && !!c.pending };
}
function displayName(store, userId) {
  const c = contactOf(store, userId);
  if (c?.name)
    return c.name;
  const u = store.users.get(userId);
  return u ? u.publicName ?? u.name : "";
}
function personView(store, userId) {
  const u = store.users.get(userId), c = contactOf(store, userId);
  const pend = c?.pending ? "p" + c.name : "";
  return { name: displayName(store, userId), photo: u?.photo ?? null, sig: `${u?.v ?? 0}:${c?.v ?? 0}:${pend}` };
}
function peopleResult(store, ids, me) {
  const items = new Map, sig = new Map, order = [];
  for (const id of ids) {
    const key = String(id);
    if (items.has(key))
      continue;
    let it, g;
    if (me && id === me.userId) {
      it = { key, id, name: me.name, photo: me.photo ?? null };
      g = "me:" + JSON.stringify([me.name, me.photo ?? null]);
    } else {
      const p = personView(store, id);
      if (!p.name && !store.users.get(id))
        continue;
      it = { key, id, name: p.name, photo: p.photo };
      g = p.sig;
    }
    items.set(key, it);
    sig.set(key, g);
    order.push(key);
  }
  return { items, order, sig };
}
function chatTitle(store, c) {
  if (c.group)
    return c.group.title;
  if (c.saved)
    return SAVED_TITLE;
  return c.peerId != null ? displayName(store, c.peerId) || null : null;
}

class PeerSigs {
  shown = new Map;
  retouch(store) {
    if (this.shown.size > store.chats.size * 2)
      this.shown.clear();
    for (const c of store.chats.values()) {
      if (c.group || c.peerId == null)
        continue;
      const sig = c.peerId + ":" + personView(store, c.peerId).sig;
      if (this.shown.get(c.id) === sig)
        continue;
      this.shown.set(c.id, sig);
      store.retouch(c.id);
    }
  }
}

// packages/sync-engine/src/types.ts
var PENDING_BASE = 2 ** 52;
function toQuote(m) {
  const a = m.attachment;
  return {
    id: m.id,
    sort: m.sort ?? m.id,
    body: m.body,
    senderId: m.senderId,
    kind: m.kind ?? "text",
    deleted: !!m.deleted,
    entities: m.entities ?? undefined,
    attachment: a ? { id: a.id, kind: a.kind, mime: a.mime, name: a.name, thumb: a.thumb ?? null, title: a.title ?? null, performer: a.performer ?? null, duration: a.duration ?? null } : null,
    service: m.service ?? undefined,
    todo: m.todo ? { title: m.todo.title } : null,
    article: !!m.blocks?.length,
    ...m.sticker ? { sticker: m.sticker } : {},
    ...m.poll ? { poll: { question: m.poll.question, quiz: m.poll.quiz } } : {},
    ...m.contact ? { contact: m.contact } : {},
    ...m.geo ? { geo: m.geo } : {},
    ...m.dice ? { dice: m.dice } : {}
  };
}

// packages/sync-engine/src/queries.ts
var muteKey = (chatId) => "mute:" + chatId;
var autoDeleteKey = (chatId) => "autoDelete:" + chatId;
var flagsKey = (chatId) => "flags:" + chatId;
function flagsOverlay(ops) {
  const m = new Map;
  for (const o of ops) {
    if (o.key.startsWith("flags:"))
      m.set(Number(o.key.slice(6)), o.body);
    else if (o.key.startsWith("unarchive:"))
      m.set(Number(o.key.slice(10)), { pinned: false, archived: false, at: 0 });
  }
  return m;
}
function flagsOf(c, over) {
  if (!over)
    return { pinnedAt: c.pinnedAt ?? null, archived: !!c.archived, unreadMark: !!c.unreadMark };
  const keep = c.pinnedAt != null && !!c.archived === over.archived;
  return { pinnedAt: over.pinned ? keep ? c.pinnedAt : over.at : null, archived: over.archived, unreadMark: over.unreadMark ?? !!c.unreadMark };
}
function muteOverlay(ops) {
  const m = new Map;
  for (const o of ops)
    if (o.key.startsWith("mute:"))
      m.set(Number(o.key.slice(5)), o.body.muteUntil);
  return m;
}
function autoDeleteOverlay(ops) {
  const m = new Map;
  for (const o of ops)
    if (o.key.startsWith("autoDelete:"))
      m.set(Number(o.key.slice(11)), o.body.sec);
  return m;
}
function result(list) {
  const items = new Map, sig = new Map;
  for (const it of list) {
    items.set(it.key, it);
    sig.set(it.key, JSON.stringify(it));
  }
  return { items, order: list.map((i) => i.key), sig };
}
var sortAt = (c) => c.draft && c.draft.at > c.lastAt ? c.draft.at : c.lastAt;
var chatItem = (store, c, person, muteUntil, f, autoDeleteSec) => {
  const title = chatTitle(store, c);
  return {
    key: "c" + c.id,
    id: c.id,
    kind: c.kind,
    title,
    peerId: c.peerId,
    saved: !!c.saved,
    peer: c.peerId != null ? { id: c.peerId, name: title, ...c.system ? { system: true } : null } : null,
    unread: c.unread,
    lastReadId: c.lastReadId,
    lastAt: c.lastAt,
    canSend: canPost(c),
    photo: person ? person.photo : c.group?.photo ?? null,
    group: c.group ?? null,
    me: c.me ?? null,
    membersRev: store.members.rev(c.id),
    sortAt: sortAt(c),
    draft: c.draft?.text ?? null,
    draftEntities: c.draft?.entities ?? null,
    pinned: c.pinned ?? [],
    muteUntil,
    scheduled: store.scheduledCount(c.id),
    pinnedAt: f.pinnedAt,
    archived: f.archived,
    unreadMark: f.unreadMark,
    mentions: c.mentions ?? 0,
    theme: c.theme ?? null,
    groupCall: c.groupCall ?? null,
    groupCallPlan: c.groupCallPlan ?? null,
    autoDeleteSec,
    reactions: c.reactions ?? 0,
    reactionIds: c.reactionIds ?? null,
    last: c.last ? {
      key: c.last.key,
      id: c.last.id,
      senderId: c.last.senderId,
      body: c.last.body,
      status: c.last.status,
      createdAt: c.last.createdAt,
      deleted: !!c.last.deleted,
      kind: c.last.kind ?? "text",
      attachmentName: c.last.attachment?.name ?? null,
      attachmentTitle: c.last.attachment?.title ?? null,
      attachmentPerformer: c.last.attachment?.performer ?? null,
      entities: c.last.entities ?? null,
      thumb: c.last.attachment?.thumb ?? null,
      mime: c.last.attachment?.mime ?? null,
      ...c.last.sticker ? { sticker: c.last.sticker } : {},
      ...c.last.fwdFrom ? { fwd: true } : null,
      ...c.last.service ? { service: c.last.service } : null
    } : null
  };
};
var chatCache = new WeakMap;
function chatListItem(store, c, mute, flags, auto) {
  const person = !c.group && c.peerId != null ? personView(store, c.peerId) : null;
  if (person && c.peerId != null && !store.users.get(c.peerId))
    store.wantUser(c.peerId);
  const typing = store.typing.has(c.id);
  const typers = c.group ? [...store.typing.get(c.id) ?? []].map((u) => {
    if (!store.users.get(u))
      store.wantUser(u);
    return displayName(store, u).split(" ")[0];
  }) : [];
  const muteUntil = mute.has(c.id) ? mute.get(c.id) : c.muteUntil ?? null;
  const autoDeleteSec = auto.has(c.id) ? auto.get(c.id) : c.autoDeleteSec ?? null;
  const f = flagsOf(c, flags.get(c.id));
  const sig = `${store.chatVersion(c.id)}|${person?.sig ?? ""}|${typing}:${typers.join(",")}|${muteUntil}|${store.members.rev(c.id)}|${f.pinnedAt}|${f.archived}|${f.unreadMark}|${autoDeleteSec}`;
  let hit = chatCache.get(c);
  if (!hit || hit.sig !== sig) {
    hit = { sig, item: { ...chatItem(store, c, person, muteUntil, f, autoDeleteSec), typing, ...typers.length ? { typers } : null } };
    chatCache.set(c, hit);
  }
  return hit;
}
var msgSig = (m, q, fxAt) => `${fxAt ?? ""}|${m.id}|${m.expiresAt ?? ""}|${m.status}|${m.sort}|${m.replyToId}|${m.replyQuote ? m.replyQuote.offset + ":" + m.replyQuote.text + ":" + (m.replyQuote.entities?.length ?? 0) : ""}|${m.body}|${m.editedAt ?? ""}|${m.deleted ? 1 : 0}|${m.reactions?.map((r) => r.userId + r.emoji).join(",") ?? ""}|${m.attachment ? m.attachment.id + ":" + (m.progress ?? "") + ":" + m.attachment.size + (m.attachment.preview ? ":p" : "") + ":" + (m.attachment.variants?.length ?? 0) : ""}|${q ? q.id + ":" + q.body + ":" + (q.deleted ? 1 : 0) + ":" + (q.attachment?.thumb?.length ?? 0) + ":" + (q.entities?.length ?? 0) : ""}|${m.error ?? ""}|${m.listened ? 1 : 0}|${m.entities?.map((e) => e.type + e.offset + ":" + e.length + (e.url ?? "") + (e.collapsed ? "c" : "")).join(",") ?? ""}|${m.todo ? JSON.stringify(m.todo) : ""}|${m.poll ? JSON.stringify(m.poll) : ""}|${m.contact || m.geo || m.dice ? JSON.stringify([m.contact, m.geo, m.dice]) : ""}|${m.service?.data ? JSON.stringify(m.service.data) : ""}|${m.buttons ? JSON.stringify(m.buttons) : ""}|${m.views ?? ""}|${m.reactionCounts?.map((r) => r[0] + r[1]).join(",") ?? ""}|${m.myReaction ?? ""}|${m.postAuthor ?? ""}|${m.replies ? m.replies.count + ":" + m.replies.lastId + ":" + m.replies.recent.join(",") + ":" + (m.replies.readMaxId ?? "") : ""}`;
var msgCache = new WeakMap;
var messageItem = (m, q, fx) => {
  const sig = msgSig(m, q, fx?.at);
  let c = msgCache.get(m);
  if (!c || c.sig !== sig) {
    c = { sig, item: { ...m, reply: q, ...fx ? { fx } : {} } };
    msgCache.set(m, c);
  }
  return c;
};
function lowerBound(arr, s, lo = 0, hi = arr.length) {
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (arr[mid].sort < s)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
function upperBound(arr, s) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (arr[mid].sort <= s)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
function rangeAt(ranges, sort) {
  const n = ranges.length;
  if (sort == null || n === 0 || sort > ranges[n - 1][1])
    return n - 1;
  let i = 0;
  while (ranges[i][1] < sort)
    i++;
  return i;
}
function feedSpan(chat, all, sort) {
  if (!chat)
    return { lo: 0, hi: all.length, i: -1, start: false, live: true };
  const ranges = chat.ranges, i = rangeAt(ranges, sort), live = i === ranges.length - 1;
  const lo = lowerBound(all, i < 0 ? PENDING_BASE : ranges[i][0]);
  return { lo, hi: live ? all.length : upperBound(all, ranges[i][1]), i, start: i <= 0 && !!chat.historyStart, live };
}
function messageWindow(all, q, lo = 0, hi = all.length) {
  const limit = q.limit;
  if (!q.anchor)
    return { from: Math.max(lo, hi - limit), to: hi };
  const i = lowerBound(all, q.anchor.sort, lo, hi);
  if (q.anchor.side === "end") {
    const to = Math.min(hi, i < hi && all[i].sort === q.anchor.sort ? i + 1 : i);
    return { from: Math.max(lo, to - limit), to };
  }
  if (q.anchor.side === "start")
    return { from: i, to: Math.min(hi, i + limit) };
  let from = Math.max(lo, i - (limit >> 1));
  const to = Math.min(hi, from + limit);
  from = Math.max(lo, to - limit);
  return { from, to };
}
var feedCache = new WeakMap;
function feedMessages(store, chatId) {
  const all = store.chatMessages(chatId);
  let list = feedCache.get(all);
  if (!list) {
    list = all.some((m) => m.deleted) ? all.filter((m) => !m.deleted) : all;
    feedCache.set(all, list);
  }
  return list;
}
var threadCache = new WeakMap;
function threadMessages(store, chatId, threadId) {
  const all = store.chatMessages(chatId);
  let by = threadCache.get(all);
  if (!by) {
    by = new Map;
    threadCache.set(all, by);
  }
  let list = by.get(threadId);
  if (!list) {
    list = all.filter((m) => m.threadId === threadId && !m.deleted);
    by.set(threadId, list);
  }
  return list;
}
function threadView(store, q) {
  const all = threadMessages(store, q.chatId, q.threadId);
  const span = feedSpan(store.threadRanges(q.chatId, q.threadId) ?? { ranges: [] }, all, q.anchor?.sort);
  return { all, span, ...messageWindow(all, q, span.lo, span.hi) };
}
function windowItems(store, chatId, all, from, to, out) {
  const missingQuotes = new Set;
  for (let k = from;k < to; k++) {
    const m = all[k];
    let quote = null;
    if (m.replyToId != null) {
      const r = store.messageById(chatId, m.replyToId);
      quote = r ? toQuote(r) : store.quoteFor(chatId, m.replyToId) ?? null;
      if (!quote)
        missingQuotes.add(m.replyToId);
    }
    const { item, sig: g } = messageItem(m, quote, m.id != null ? store.emojiFx.get(chatId + ":" + m.id) : undefined);
    out.items.set(item.key, item);
    out.sig.set(item.key, g);
    out.order.push(item.key);
  }
  if (missingQuotes.size)
    store.wantQuotes(chatId, [...missingQuotes]);
}
function scheduledResult(store, chatId) {
  const all = store.scheduledMessages(chatId);
  const out = { items: new Map, sig: new Map, order: [] };
  windowItems(store, chatId, all, 0, all.length, out);
  const meta = { key: "~window", hasOlder: false, hasNewer: false, live: true };
  out.items.set(meta.key, meta);
  out.sig.set(meta.key, JSON.stringify(meta));
  out.order.push(meta.key);
  return out;
}
function computeQuery(store, q, mute = new Map, flags = new Map, auto = new Map) {
  switch (q.kind) {
    case "chatList": {
      const pin = (c) => flagsOf(c, flags.get(c.id)).pinnedAt;
      const chats = [...store.chats.values()].filter((c) => !store.previews.has(c.id)).sort((a, b) => {
        const pa = pin(a), pb = pin(b);
        if (pa != null || pb != null) {
          if (pa == null)
            return 1;
          if (pb == null)
            return -1;
          if (pa !== pb)
            return pb - pa;
        }
        const x = sortAt(a), y = sortAt(b);
        return x < y ? 1 : x > y ? -1 : b.id - a.id;
      });
      const items = new Map, sig = new Map, order = [];
      for (const c of chats.slice(0, q.limit)) {
        const { item, sig: g } = chatListItem(store, c, mute, flags, auto);
        items.set(item.key, item);
        sig.set(item.key, g);
        order.push(item.key);
      }
      return { items, sig, order };
    }
    case "previews": {
      const items = new Map, sig = new Map, order = [];
      for (const id of store.previews) {
        const c = store.chats.get(id);
        if (!c)
          continue;
        const { item, sig: g } = chatListItem(store, c, mute, flags, auto);
        const it = { ...item, preview: true, requested: !!c.requested };
        items.set(it.key, it);
        sig.set(it.key, g);
        order.push(it.key);
      }
      return { items, sig, order };
    }
    case "messages": {
      const all = feedMessages(store, q.chatId);
      const chat = store.chats.get(q.chatId);
      const span = feedSpan(chat, all, q.anchor?.sort);
      const { from, to } = messageWindow(all, q, span.lo, span.hi);
      const items = new Map, sig = new Map, order = [];
      const missingQuotes = new Set;
      for (let k = from;k < to; k++) {
        const m = all[k];
        let quote = null;
        if (m.replyToId != null) {
          const r = store.messageById(q.chatId, m.replyToId);
          quote = r ? toQuote(r) : store.quoteFor(q.chatId, m.replyToId) ?? null;
          if (!quote)
            missingQuotes.add(m.replyToId);
        }
        const { item, sig: g } = messageItem(m, quote, m.id != null ? store.emojiFx.get(q.chatId + ":" + m.id) : undefined);
        items.set(item.key, item);
        sig.set(item.key, g);
        order.push(item.key);
      }
      const filling = !q.anchor && !span.start && to - from < q.limit;
      const meta = { key: "~window", hasOlder: from > span.lo || !span.start, hasNewer: to < span.hi || !span.live, live: !q.anchor || span.live && to === span.hi, filling };
      items.set(meta.key, meta);
      sig.set(meta.key, `${meta.hasOlder}|${meta.hasNewer}|${meta.live}|${filling}`);
      order.push(meta.key);
      if (missingQuotes.size)
        store.wantQuotes(q.chatId, [...missingQuotes]);
      return { items, sig, order };
    }
    case "thread": {
      const { all, span, from, to } = threadView(store, q);
      const out = { items: new Map, sig: new Map, order: [] };
      const header = store.messageById(q.chatId, q.threadId);
      if (header) {
        const { item, sig: g } = messageItem(header, null);
        out.items.set(item.key, item);
        out.sig.set(item.key, g);
        out.order.push(item.key);
      }
      windowItems(store, q.chatId, all, from, to, out);
      const meta = { key: "~window", hasOlder: from > span.lo || !span.start, hasNewer: to < span.hi || !span.live, live: !q.anchor || span.live && to === span.hi };
      const guest = store.guestInfo(q.chatId);
      const th = { key: "~thread", header: header?.key ?? null, loaded: !!store.threadRanges(q.chatId, q.threadId), ...guest ? { guest } : {} };
      for (const it of [meta, th]) {
        out.items.set(it.key, it);
        out.sig.set(it.key, JSON.stringify(it));
        out.order.push(it.key);
      }
      return out;
    }
    case "uploads": {
      const list = [];
      for (const o of store.outbox.values()) {
        if (o.failed || !o.attachment || o.forward)
          continue;
        list.push({
          key: o.clientId,
          chatId: o.chatId,
          name: o.attachment.name,
          size: o.attachment.size,
          kind: o.attachment.kind,
          mime: o.attachment.mime,
          uploaded: !!o.attachment.id,
          progress: o.attachment.id ? 1 : Math.round(store.progressOf(o.clientId) * 100) / 100
        });
      }
      return result(list);
    }
    case "counters": {
      let unreadChats = 0, unreadMessages = 0, archivedUnread = 0;
      for (const c of store.chats.values()) {
        if (store.previews.has(c.id))
          continue;
        const f = flagsOf(c, flags.get(c.id));
        if (!(c.unread > 0 || f.unreadMark))
          continue;
        if (f.archived) {
          archivedUnread++;
          continue;
        }
        unreadChats++;
        unreadMessages += c.unread;
      }
      return result([{ key: "counters", unreadChats, unreadMessages, archivedUnread }]);
    }
    case "notifications":
      return result(store.notifications);
    case "scheduled":
      return scheduledResult(store, q.chatId);
    case "status":
    case "presence":
    case "me":
    case "user":
    case "people":
    case "ops":
    case "contacts":
    case "settings":
    case "blocked":
    case "members":
    case "media":
    case "savedFeed":
    case "savedDialogs":
    case "profileMusic":
    case "profilePhotos":
    case "devStats":
    case "devLog":
      throw new Error(q.kind + " is computed by the engine");
  }
}
function affects(q, touched) {
  if (!touched.size)
    return false;
  if (q.kind === "status" || q.kind === "me" || q.kind === "user" || q.kind === "people" || q.kind === "ops" || q.kind === "contacts" || q.kind === "settings" || q.kind === "blocked" || q.kind === "members" || q.kind === "profileMusic" || q.kind === "profilePhotos" || q.kind === "devStats" || q.kind === "devLog")
    return false;
  return q.kind === "messages" || q.kind === "media" || q.kind === "thread" || q.kind === "scheduled" || q.kind === "savedFeed" ? touched.has(q.chatId) : true;
}
function diffResults(prev, next) {
  if (!prev)
    return { op: "snapshot", items: next.order.map((k) => next.items.get(k)), order: next.order };
  const upsert = [], remove = [];
  for (const k of next.order)
    if (prev.sig.get(k) !== next.sig.get(k))
      upsert.push(next.items.get(k));
  for (const k of prev.order)
    if (!next.items.has(k))
      remove.push(k);
  const orderChanged = prev.order.length !== next.order.length || prev.order.some((k, i) => k !== next.order[i]);
  if (!upsert.length && !remove.length && !orderChanged)
    return null;
  return orderChanged ? { op: "diff", upsert, remove, order: next.order } : { op: "diff", upsert, remove };
}

// packages/sync-engine/src/savedDialogs.ts
var NO_META = { loaded: false, total: 0, messages: 0, next: null };
var savedPinKey = (peer) => "savedPin:" + peer;
var savedDeleteKey = (peer) => "savedDelete:" + peer;

class SavedDialogsCache {
  rows = new Map;
  meta = { ...NO_META };
  rev = 0;
  want = false;
  dirty = new Set;
  removed = new Set;
  metaDirty = false;
  static async load(rows, meta) {
    const c = new SavedDialogsCache;
    for (const r of rows)
      c.rows.set(r.peer, r);
    const m = meta.find((x) => x.k === "savedDialogs")?.v;
    if (m)
      c.meta = m;
    return c;
  }
  put(r) {
    this.rows.set(r.peer, r);
    this.dirty.add(r.peer);
    this.removed.delete(r.peer);
  }
  drop(peer) {
    if (this.rows.delete(peer)) {
      this.removed.add(peer);
      this.dirty.delete(peer);
    }
  }
  setMeta(m) {
    this.meta = { ...this.meta, ...m };
    this.metaDirty = true;
  }
  reset() {
    for (const p of this.rows.keys())
      this.removed.add(p);
    this.rows.clear();
    this.dirty.clear();
    this.meta = { ...NO_META };
    this.metaDirty = true;
    this.rev++;
  }
  collect() {
    const put = [...this.dirty].map((k) => this.rows.get(k)).filter(Boolean), del = [...this.removed];
    const meta = this.metaDirty ? { k: "savedDialogs", v: this.meta } : null;
    this.dirty.clear();
    this.removed.clear();
    this.metaDirty = false;
    return { put, del, meta };
  }
}
var savedChatOf = (store) => {
  for (const c of store.chats.values())
    if (c.saved)
      return c;
  return;
};
function toLocal(store, d) {
  const last = d.lastId != null && store.isLoaded(d.last?.chatId ?? -1) ? store.messageById(d.last.chatId, d.lastId) : undefined;
  return { ...d, last: last ?? (d.last ? store.localOf(d.last) : null) };
}
function applySavedPage(store, chatId, page, at) {
  const cache = store.savedDialogs;
  const seen = new Set;
  for (const d of page.dialogs) {
    seen.add(d.peer);
    cache.put(toLocal(store, d));
  }
  if (at == null) {
    const floor = page.next == null ? -Infinity : Math.min(...page.dialogs.filter((d) => d.peer !== "me" && !d.pinnedAt).map((d) => d.lastId ?? Infinity));
    for (const [peer, r] of [...cache.rows]) {
      if (seen.has(peer))
        continue;
      if (r.peer === "me" || r.pinnedAt != null || (r.lastId ?? 0) >= floor)
        cache.drop(peer);
    }
  }
  cache.setMeta({ loaded: true, total: page.total, messages: page.messages, next: page.next });
  store.touch(chatId);
}
function applySavedEvent(store, u) {
  const cache = store.savedDialogs;
  cache.rev++;
  cache.setMeta({ total: u.dialogs, messages: u.messages });
  if (!u.count) {
    cache.drop(u.peer);
    store.touch(u.chatId);
    return;
  }
  const row = cache.rows.get(u.peer);
  const known = u.lastId != null ? store.messageById(u.chatId, u.lastId) : undefined;
  const last = known ?? (row?.last?.id === u.lastId ? row.last : null);
  if (!row || !last)
    cache.want = true;
  cache.put({ ...row ?? blankRow(u.peer, last), count: u.count, lastId: u.lastId, pinnedAt: u.pinnedAt, last });
  store.touch(u.chatId);
}
function blankRow(peer, m) {
  const f = m?.fwdFrom ?? null;
  const kind = peer[0] === "u" ? "user" : peer[0] === "c" ? f?.userId == null ? "channel" : "group" : null;
  return { peer, count: 0, lastId: m?.id ?? null, last: m, pinnedAt: null, title: f?.name ?? null, photo: f?.photo ?? null, kind, access: false };
}
function savedOnMessage(store, chat, m, kind, prev) {
  const peer = m.savedPeer ?? prev?.savedPeer;
  if (!peer)
    return;
  const cache = store.savedDialogs;
  const row = cache.rows.get(peer);
  if (kind === "deleted") {
    if (!row)
      return;
    const count = row.count - 1;
    cache.setMeta({ messages: Math.max(0, cache.meta.messages - 1), ...count <= 0 ? { total: Math.max(0, cache.meta.total - 1) } : {} });
    if (count <= 0) {
      cache.drop(peer);
      store.touch(chat.id);
      return;
    }
    const was = row.last?.key === m.key;
    const list = was ? savedMessages(store, chat.id, peer) : null;
    const next = list ? [...list].reverse().find((x) => x.key !== m.key) ?? null : row.last;
    if (was && !next)
      cache.want = true;
    cache.put({ ...row, count, last: next, lastId: next ? next.id : row.lastId });
    store.touch(chat.id);
    return;
  }
  if (m.deleted)
    return;
  if (m.id == null && !prev) {
    cache.setMeta({ messages: cache.meta.messages + 1, ...row ? {} : { total: cache.meta.total + 1 } });
    cache.put({ ...row ?? blankRow(peer, m), count: (row?.count ?? 0) + 1, last: m });
    store.touch(chat.id);
    return;
  }
  if (!row)
    return;
  if (row.last?.key === m.key || !row.last || m.sort >= row.last.sort) {
    cache.put({ ...row, last: m, lastId: m.id ?? row.lastId });
    store.touch(chat.id);
  }
}
function dropSavedLocally(store, chatId, peer, upToId) {
  for (const m of [...savedMessages(store, chatId, peer)])
    if (m.id != null && m.id <= upToId)
      store.applyUpdate({ type: "messageDeleted", chatId, id: m.id });
  const row = store.savedDialogs.rows.get(peer);
  if (row) {
    store.savedDialogs.setMeta({ messages: Math.max(0, store.savedDialogs.meta.messages - row.count), total: Math.max(0, store.savedDialogs.meta.total - 1) });
    store.savedDialogs.drop(peer);
  }
  store.touch(chatId);
}
var byPeer = new WeakMap;
function savedMessages(store, chatId, peer) {
  const all = store.chatMessages(chatId);
  let by = byPeer.get(all);
  if (!by) {
    by = new Map;
    for (const m of all)
      if (m.savedPeer && !m.deleted) {
        const l = by.get(m.savedPeer);
        if (l)
          l.push(m);
        else
          by.set(m.savedPeer, [m]);
      }
    byPeer.set(all, by);
  }
  return by.get(peer) ?? [];
}
function savedFloor(chat, peer) {
  if (!chat)
    return Infinity;
  const own = chat.savedViews?.[peer]?.floor, live = chat.ranges[chat.ranges.length - 1];
  if (own === true || chat.historyStart && chat.ranges.length === 1)
    return true;
  return Math.min(own ?? Infinity, live ? live[0] : Infinity);
}
function savedView(store, q) {
  const all = savedMessages(store, q.chatId, q.peer), floor = savedFloor(store.chats.get(q.chatId), q.peer);
  const lo = floor === true ? 0 : lowerBound(all, Math.min(floor, PENDING_BASE)), hi = all.length;
  return { all, lo, hi, floor, ...messageWindow(all, q, lo, hi) };
}
function savedFeedResult(store, q) {
  const { all, lo, hi, floor, from, to } = savedView(store, q);
  const out = { items: new Map, sig: new Map, order: [] };
  windowItems(store, q.chatId, all, from, to, out);
  const meta = { key: "~window", hasOlder: from > lo || floor !== true, hasNewer: to < hi, live: !q.anchor || to === hi, filling: !q.anchor && floor !== true && to === from };
  out.items.set(meta.key, meta);
  out.sig.set(meta.key, JSON.stringify(meta));
  out.order.push(meta.key);
  return out;
}
var lastItem = (m) => m ? {
  key: m.key,
  id: m.id,
  senderId: m.senderId,
  body: m.body,
  status: m.status,
  createdAt: m.createdAt,
  deleted: !!m.deleted,
  kind: m.kind ?? "text",
  attachmentName: m.attachment?.name ?? null,
  attachmentTitle: m.attachment?.title ?? null,
  attachmentPerformer: m.attachment?.performer ?? null,
  entities: m.entities ?? null,
  thumb: m.attachment?.thumb ?? null,
  mime: m.attachment?.mime ?? null,
  ...m.sticker ? { sticker: m.sticker } : {},
  ...m.fwdFrom ? { fwd: true } : null,
  ...m.service ? { service: m.service } : null
} : null;
function savedPinOverlay(ops) {
  const out = new Map;
  for (const o of ops)
    if (o.key.startsWith("savedPin:"))
      out.set(o.key.slice(9), o.body);
  return out;
}
function savedOrder(rows) {
  return [...rows].sort((a, b) => {
    if (a.peer === "me" || b.peer === "me")
      return a.peer === "me" ? -1 : 1;
    if (a.pinnedAt != null || b.pinnedAt != null) {
      if (a.pinnedAt == null)
        return 1;
      if (b.pinnedAt == null)
        return -1;
      if (a.pinnedAt !== b.pinnedAt)
        return b.pinnedAt - a.pinnedAt;
    }
    return b.lastSort - a.lastSort;
  });
}
function savedDialogsResult(store, ops) {
  const cache = store.savedDialogs, pins = savedPinOverlay(ops);
  const gone = new Set(ops.filter((o) => o.key.startsWith("savedDelete:")).map((o) => o.key.slice(12)));
  const rows = [];
  for (const r of cache.rows.values()) {
    if (gone.has(r.peer))
      continue;
    const over = pins.get(r.peer);
    let { title, photo } = r;
    let { kind, access } = r;
    const id = Number(r.peer.slice(1));
    if (r.peer[0] === "u") {
      const p = personView(store, id);
      if (p) {
        title = p.name ?? title;
        photo = p.photo ?? null;
      }
      if (!store.users.get(id))
        store.wantUser(id);
    } else if (r.peer[0] === "c") {
      const c = store.chats.get(id);
      if (c?.group && !store.previews.has(id)) {
        title = chatTitle(store, c);
        photo = c.group.photo ?? null;
        kind = c.kind === "channel" ? "channel" : "group";
        access = true;
      }
    }
    rows.push({
      key: r.peer,
      peer: r.peer,
      count: r.count,
      lastId: r.lastId,
      lastSort: r.last?.sort ?? r.lastId ?? 0,
      last: lastItem(r.last),
      createdAt: r.last?.createdAt ?? null,
      pinnedAt: over ? over.pinned ? r.pinnedAt ?? over.at : null : r.pinnedAt,
      title,
      photo,
      kind,
      access,
      ...r.userId != null ? { userId: r.userId } : r.peer[0] === "u" ? { userId: id } : {},
      ...r.key ? { peerKey: r.key } : {},
      ...access && r.peer[0] === "c" ? { sourceChatId: id } : {}
    });
  }
  const list = savedOrder(rows);
  const out = { items: new Map, sig: new Map, order: [] };
  for (const it of list) {
    out.items.set(it.key, it);
    out.sig.set(it.key, JSON.stringify(it));
    out.order.push(it.key);
  }
  const meta = { key: "~saved", loaded: cache.meta.loaded, total: Math.max(0, cache.meta.total - [...gone].filter((p) => cache.rows.has(p)).length), messages: cache.meta.messages, done: cache.meta.next == null, chatId: savedChatOf(store)?.id ?? null };
  out.items.set(meta.key, meta);
  out.sig.set(meta.key, JSON.stringify(meta));
  out.order.push(meta.key);
  return out;
}

// packages/sync-engine/src/derive.ts
function onMessage(store, chat, m, kind, prev) {
  countMedia(chat, m, prev);
  if (chat.saved) {
    const view = m.savedPeer ? chat.savedViews?.[m.savedPeer] : undefined;
    if (view)
      countMedia(view, m, prev);
    savedOnMessage(store, chat, m, kind, prev);
  }
  const last = chat.last;
  if (kind === "deleted") {
    if (last?.key === m.key) {
      recomputeLast(store, chat, m.sort);
      if (!chat.last)
        store.wantRow(chat.id);
    }
  } else if (!m.deleted && (!last || last.deleted || last.key === m.key || m.sort >= last.sort)) {
    chat.last = m;
    if (m.createdAt > chat.lastAt)
      chat.lastAt = m.createdAt;
  }
  store.markChat(chat);
}
function sameRange(chat, a, b) {
  const has = (rs) => rs.some((r) => r[0] <= a && b <= r[1]);
  return has(chat.ranges) || Object.values(chat.threads ?? {}).some((t) => has(t.ranges));
}
function recomputeLast(store, chat, gone) {
  const all = store.chatMessages(chat.id);
  let last = null;
  for (let i = all.length - 1;i >= 0; i--) {
    if (all[i].deleted)
      continue;
    const s = all[i].sort;
    if (gone != null && s < PENDING_BASE && !sameRange(chat, s, gone))
      break;
    last = all[i];
    chat.lastAt = last.createdAt;
    break;
  }
  chat.last = last;
}
function unreadOnArrival(store, chat, m, live) {
  if (live && m.senderId !== store.userId && m.id > chat.lastReadId && m.id > chat.knownMaxId)
    chat.unread++;
}
function unreadAfterRead(store, chat, from, to) {
  if (to >= chat.knownMaxId)
    return 0;
  let n = 0;
  for (const m of store.chatMessages(chat.id)) {
    if (m.senderId !== store.userId && m.id != null && m.id > from && m.id <= to)
      n++;
  }
  return Math.max(0, chat.unread - n);
}
function tabsOf(m) {
  if (m.deleted || m.id == null)
    return [];
  return mediaTabs({ kind: m.kind ?? "text", attachment: m.attachment, body: m.body, entities: m.entities, service: m.service });
}
function countMedia(chat, m, prev) {
  const counts = chat.mediaCounts;
  if (!counts || m.id == null)
    return;
  const video = (x) => tabsOf(x).includes("media") && isVideoMedia(x);
  if (m.id > (chat.mediaCountsAt ?? 0)) {
    chat.mediaCountsAt = m.id;
    for (const t of tabsOf(m))
      counts[t]++;
    if (counts.video != null && video(m))
      counts.video++;
    return;
  }
  if (prev?.id == null)
    return;
  const before = tabsOf(prev), after = tabsOf(m);
  for (const t of before)
    if (!after.includes(t))
      counts[t] = Math.max(0, counts[t] - 1);
  for (const t of after)
    if (!before.includes(t))
      counts[t]++;
  if (counts.video != null && video(prev) !== video(m))
    counts.video = Math.max(0, counts.video + (video(m) ? 1 : -1));
}

// packages/sync-engine/src/schema.ts
var SCHEMA_VERSION = 9;
var SCHEMA = {
  chats: { keyPath: "id" },
  messages: { keyPath: "key", indexes: [{ name: "byChat", keyPath: ["chatId", "sort"] }, { name: "byTab", keyPath: ["chatId", "tab", "sort"] }, { name: "byExpiry", keyPath: "expiresAt" }] },
  users: { keyPath: "id" },
  contacts: { keyPath: "userId" },
  blocked: { keyPath: "userId" },
  members: { keyPath: ["chatId", "userId"], indexes: [{ name: "byChat", keyPath: ["chatId", "order"] }] },
  profileMusic: { keyPath: ["userId", "attId"], indexes: [{ name: "byUser", keyPath: ["userId", "addedAt"] }] },
  profilePhotos: { keyPath: ["userId", "pid"], indexes: [{ name: "byUser", keyPath: ["userId", "at"] }] },
  terms: { keyPath: ["term", "chatId", "sort"] },
  scheduled: { keyPath: "clientId" },
  savedDialogs: { keyPath: "peer" },
  chatSeq: { keyPath: "chatId" },
  meta: { keyPath: "k" },
  outbox: { keyPath: "clientId", keep: true },
  blobs: { keyPath: "clientId", keep: true },
  ops: { keyPath: "id", keep: true },
  pendingReads: { keyPath: "chatId", keep: true }
};
var STORES = Object.keys(SCHEMA);
var KEEP_STORES = STORES.filter((s) => SCHEMA[s].keep);
var CACHE_STORES = STORES.filter((s) => !SCHEMA[s].keep);
function upgrade(db, oldVersion, tx) {
  for (const name of STORES) {
    const def = SCHEMA[name];
    if (oldVersion > 0 && oldVersion < 6 && !def.keep && db.objectStoreNames.contains(name))
      db.deleteObjectStore(name);
    const store = db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, { keyPath: def.keyPath });
    for (const ix of def.indexes ?? [])
      if (!store.indexNames.contains(ix.name))
        store.createIndex(ix.name, ix.keyPath);
  }
}

// packages/sync-engine/src/idb.ts
function openDb(name, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, opts.version ?? SCHEMA_VERSION);
    r.onblocked = () => console.warn(`idb ${name}: upgrade to v${opts.version ?? SCHEMA_VERSION} is waiting for other tabs to close the old version`);
    r.onupgradeneeded = (e) => upgrade(r.result, e.oldVersion, r.transaction);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => {
        db.close();
        opts.onVersionChange?.();
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
}
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function getAll(db, store) {
  return req(db.transaction(store).objectStore(store).getAll());
}
function getByChat(db, chatId) {
  const index = db.transaction("messages").objectStore("messages").index("byChat");
  return req(index.getAll(IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity])));
}
function termsOf(m) {
  if (m.id == null || m.deleted)
    return [];
  const a = m.attachment;
  return searchTerms(a ? [a.name, a.title, a.performer, m.body].filter(Boolean).join(" ") : m.body);
}
function write(db, batch) {
  const dropChats = batch.del.chats ?? [];
  const names = STORES.filter((s) => (batch.put[s]?.length ?? 0) > 0 || (batch.del[s]?.length ?? 0) > 0 || (s === "messages" || s === "terms") && (dropChats.length > 0 || (batch.rowPatches?.length ?? 0) > 0));
  if (!names.length)
    return Promise.resolve();
  const t = db.transaction(names, "readwrite");
  for (const s of names) {
    const os = t.objectStore(s);
    for (const v of batch.put[s] ?? [])
      os.put(v);
    for (const k of batch.del[s] ?? [])
      os.delete(k);
  }
  if (dropChats.length) {
    const index = t.objectStore("messages").index("byChat");
    for (const id of dropChats) {
      const cur = index.openCursor(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c)
          return;
        const m = c.value;
        for (const term of termsOf(m))
          t.objectStore("terms").delete([term, m.chatId, m.sort]);
        c.delete();
        c.continue();
      };
    }
  }
  for (const { chatId, id, patch, drop } of batch.rowPatches ?? []) {
    const cur = t.objectStore("messages").index("byChat").openCursor(IDBKeyRange.only([chatId, id]));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c)
        return;
      const old = c.value;
      if (drop) {
        for (const term of termsOf(old))
          t.objectStore("terms").delete([term, old.chatId, old.sort]);
        c.delete();
        return;
      }
      const next = { ...old, ...patch };
      const terms = t.objectStore("terms");
      for (const term of termsOf(old))
        terms.delete([term, old.chatId, old.sort]);
      for (const term of termsOf(next))
        terms.put({ term, chatId: next.chatId, sort: next.sort, key: next.key });
      const tab = tabsOf(next)[0];
      if (tab)
        next.tab = tab;
      else
        delete next.tab;
      c.update(next);
    };
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
async function getExpiredRows(db, at) {
  return await req(db.transaction("messages").objectStore("messages").index("byExpiry").getAll(IDBKeyRange.upperBound(at)));
}
async function firstExpiry(db) {
  const c = await req(db.transaction("messages").objectStore("messages").index("byExpiry").openKeyCursor());
  return c ? c.key : null;
}
function putBlob(db, clientId, blob) {
  return req(db.transaction("blobs", "readwrite").objectStore("blobs").put({ clientId, blob }));
}
async function getBlob(db, clientId) {
  const row = await req(db.transaction("blobs").objectStore("blobs").get(clientId));
  return row?.blob ?? null;
}
function delBlob(db, clientId) {
  return req(db.transaction("blobs", "readwrite").objectStore("blobs").delete(clientId));
}

// packages/sync-engine/src/blocks.ts
var OP_BLOCK = "block:";
var blockKey = (userId) => OP_BLOCK + userId;
var blockIdOf = (key) => key.startsWith(OP_BLOCK) ? Number(key.slice(OP_BLOCK.length)) || null : null;
function baseOf2(b) {
  return { userId: b.userId, user: b.user, at: b.at };
}

class BlocksCache {
  table = new Table;
  loaded = false;
  dirty = false;
  gone = new Map;
  floor = 0;
  persist = false;
  static async load(db, meta) {
    const c = new BlocksCache;
    c.table.load(await getAll(db, "blocked"), (x) => x.userId);
    const floor = meta.find((m) => m.k === "blocksFloor")?.v;
    c.floor = floor ?? 0;
    c.loaded = floor !== undefined;
    return c;
  }
  seqOf(id) {
    return Math.max(this.table.get(id)?.seq ?? this.gone.get(id) ?? 0, this.floor);
  }
  applyBlocked(b, seq = b.seq) {
    if (seq !== undefined && seq <= this.seqOf(b.userId))
      return false;
    const prev = this.table.get(b.userId);
    this.gone.delete(b.userId);
    if (this.table.put(b.userId, baseOf2(b), seq ?? prev?.seq ?? 0))
      this.dirty = true;
    return true;
  }
  applyUnblocked(userId, seq) {
    if (seq !== undefined && seq <= this.seqOf(userId))
      return false;
    if (seq !== undefined)
      this.gone.set(userId, seq);
    if (!this.table.delete(userId))
      return true;
    this.dirty = true;
    return true;
  }
  applySnapshot(list, seq) {
    const ids = new Set(list.map((b) => b.userId));
    let changed = !this.loaded;
    for (const b of list)
      if (seq >= this.seqOf(b.userId)) {
        this.gone.delete(b.userId);
        if (this.table.put(b.userId, baseOf2(b), seq))
          changed = true;
      }
    for (const id of [...this.table.rows.keys()])
      if (!ids.has(id) && seq >= this.seqOf(id)) {
        this.table.delete(id);
        this.gone.set(id, seq);
        changed = true;
      }
    this.floor = Math.max(this.floor, seq);
    this.loaded = true;
    this.persist = true;
    if (changed)
      this.dirty = true;
  }
  collect() {
    const { put, del } = this.table.collect();
    const meta = this.persist ? [{ k: "blocksFloor", v: this.floor }] : [];
    this.persist = false;
    return { put, del, meta };
  }
  reset() {
    this.table.clear();
    this.gone.clear();
    this.floor = 0;
    this.loaded = false;
    this.dirty = true;
    this.persist = false;
  }
}
function applyBlocksChanged(store, u, seq) {
  if (u.blocked) {
    if (store.blocks.applyBlocked(u.blocked, seq))
      store.profile.applyUser(u.blocked.user, seq);
  } else if (u.unblocked) {
    store.blocks.applyUnblocked(u.unblocked, seq);
    store.refreshUser(u.unblocked);
  }
}
function blocksView(base, ops, users) {
  const view = new Map;
  for (const [id, b] of base)
    view.set(id, { ...b, pending: false });
  for (const op of ops) {
    const id = blockIdOf(op.key);
    if (!id)
      continue;
    if (op.method === "DELETE") {
      view.delete(id);
      continue;
    }
    const prev = view.get(id);
    const user = prev?.user ?? users.get(id) ?? { id, name: "", firstName: "", lastName: "", username: null, bio: null, birthday: null, phone: null, links: [] };
    view.set(id, { userId: id, user, at: prev?.at ?? new Date(op.at).toISOString(), pending: !prev || prev.pending });
  }
  return [...view.values()].sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : b.userId - a.userId);
}

class Blocks {
  h;
  constructor(h) {
    this.h = h;
  }
  get cache() {
    return this.h.store.blocks;
  }
  view() {
    return blocksView(this.cache.table.rows, this.h.ops.list, this.h.store.profile.users.rows);
  }
  chatName(id) {
    return displayName(this.h.store, id);
  }
  items() {
    const users = this.h.store.profile.users.rows;
    const list = this.view().map((b) => {
      const u = users.get(b.userId) ?? b.user;
      return { key: "b" + b.userId, userId: b.userId, name: u.name || u.publicName || this.chatName(b.userId), username: u.username, phone: u.phone, at: b.at, pending: b.pending, photo: u.photo ?? null };
    });
    list.push({ key: "~blocked", loaded: this.cache.loaded });
    return list;
  }
  fetch() {
    this.h.run(async () => {
      const r = await this.h.http("/blocks");
      this.cache.applySnapshot(r.blocked, r.seq);
      for (const b of r.blocked)
        if (this.cache.table.get(b.userId))
          this.h.store.profile.applyUser(b.user, r.seq);
      await this.h.store.flush();
      this.h.changed();
    });
  }
  opDone(op, value) {
    const id = blockIdOf(op.key);
    if (!id)
      return false;
    const v = value;
    if (v && typeof v === "object") {
      if (v.unblocked === id)
        this.cache.applyUnblocked(id, v.seq);
      else if (v.userId === id && this.cache.applyBlocked(v))
        this.h.store.profile.applyUser(v.user, v.seq);
      this.h.run(() => this.h.store.flush());
    }
    return true;
  }
  async act(a) {
    const key = blockKey(a.userId);
    if (a.type === "block")
      await this.h.ops.enqueue({ key, method: "PUT", path: `/blocks/${a.userId}` });
    else
      await this.h.ops.enqueue({ key, method: "DELETE", path: `/blocks/${a.userId}` });
    return null;
  }
}

// packages/sync-engine/src/devsim.ts
var newSim = () => ({ offline: false, profile: null, dropNextUpdates: false, forceTooLong: false, persist: false, losses: 0 });
var lossy = (s) => s.dropNextUpdates || !!s.profile && s.profile.lossPct > 0;
var simActive = (s) => s.offline || !!s.profile || s.dropNextUpdates || s.forceTooLong;
var simFlags = (s) => simActive(s) ? { offline: s.offline, profile: s.profile, dropNextUpdates: s.dropNextUpdates, forceTooLong: s.forceTooLong, persist: s.persist } : null;
var SIM_META = "devSim";
async function loadSim(db) {
  try {
    const row = await new Promise((resolve, reject) => {
      const r = db.transaction("meta").objectStore("meta").get(SIM_META);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return row?.v ?? null;
  } catch {
    return null;
  }
}
function saveSim(db, s) {
  try {
    const os = db.transaction("meta", "readwrite").objectStore("meta");
    if (s.persist && (s.offline || s.profile))
      os.put({ k: SIM_META, v: { offline: s.offline, profile: s.profile } });
    else
      os.delete(SIM_META);
  } catch {}
}
function normProfile(p) {
  return p ? { latency: +p.latency || 0, jitter: +p.jitter || 0, lossPct: Math.min(100, Math.max(0, +p.lossPct || 0)), kbps: +p.kbps || 0 } : null;
}
function oneWay(p, size) {
  return Math.max(0, p.latency / 2 + Math.random() * (p.jitter || 0) / 2 + (p.kbps > 0 ? size * 8 / p.kbps : 0));
}
var lost = (p) => !!p && p.lossPct > 0 && Math.random() * 100 < p.lossPct;
function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return cutUrl(url);
  }
}
var sleep = (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
var bodySize = (b) => typeof b === "string" ? b.length : b && typeof b.size === "number" ? b.size : 0;
function simFetch(log, sim) {
  return async (url, init) => {
    const t0 = Date.now();
    const method = init?.method ?? "GET";
    const path = pathOf(url);
    if (sim.offline) {
      log.record("engine", "http", { method, path, error: "offline (dev)" });
      throw new TypeError("Failed to fetch (dev: offline)");
    }
    if (sim.profile)
      await sleep(oneWay(sim.profile, bodySize(init?.body)));
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      log.record("engine", "http", { method, path, error: cutUrl(String(err?.message ?? err)) }, undefined, Date.now() - t0);
      throw err;
    }
    const size = Number(res.headers.get("content-length")) || undefined;
    if (sim.profile)
      await sleep(oneWay(sim.profile, size ?? 0));
    log.record("engine", "http", { method, path, status: res.status }, size, Date.now() - t0);
    return res;
  };
}
function watchLoss(sim, ms, onLoss) {
  if (!lossy(sim))
    return () => {};
  const l0 = sim.losses;
  let timer = null;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (sim.losses !== l0)
        onLoss();
      else if (lossy(sim))
        arm();
    }, ms);
  };
  arm();
  return () => {
    if (timer)
      clearTimeout(timer);
    timer = null;
  };
}

// packages/sync-engine/src/devdata.ts
var STORES2 = STORES.filter((s) => s !== "blobs");
var MAX = 200;
function readStore(db, a) {
  if (!STORES2.includes(a.store) || !db.objectStoreNames.contains(a.store))
    return Promise.reject(new Error("bad_store"));
  const limit = Math.max(1, Math.min(MAX, a.limit ?? 100));
  const offset = Math.max(0, a.offset ?? 0);
  const q = a.q?.trim() || "";
  return new Promise((resolve, reject) => {
    const os = db.transaction(a.store).objectStore(a.store);
    const src = a.store === "messages" && a.chatId != null ? os.index("byChat") : os;
    const range = a.store === "messages" && a.chatId != null ? IDBKeyRange.bound([a.chatId, -Infinity], [a.chatId, Infinity]) : undefined;
    const r = src.openCursor(range);
    const rows = [];
    let skipped = 0, advanced = !!q || offset === 0;
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) {
        resolve({ rows, offset, more: false });
        return;
      }
      if (!advanced) {
        advanced = true;
        c.advance(offset);
        return;
      }
      const key = String(c.primaryKey);
      if (!q || key.includes(q)) {
        if (q && skipped < offset)
          skipped++;
        else {
          if (rows.length === limit) {
            resolve({ rows, offset, more: true });
            return;
          }
          rows.push({ key, value: trimBodies(c.value) });
        }
      }
      c.continue();
    };
  });
}

// packages/sync-engine/src/devlog.ts
var LOG_CAP = 2000;
var BODY_MAX = 40;
var STATS_MS = 1000;
var LOG_MS = 250;
var IDB_TTL_MS = 5000;
var MSG_MAX = 160;
var cut = (s, max = BODY_MAX) => s.length > max ? s.slice(0, max) + "…" : s;
function cutUrl(s) {
  return cut(s.replace(/data:[^\s"']*/g, (d) => `data:…(${d.length})`).replace(/\?[^\s"']*/g, "?…"), MSG_MAX);
}
var hideDigits = (s) => s.replace(/\d/g, "•");
var isLoginCode = (o) => o.service?.type === "login_code";
function trimOwn(o) {
  const b = typeof o.body === "string", t = typeof o.text === "string", th = typeof o.thumb === "string";
  if (!b && !t && !th)
    return o;
  const c = { ...o };
  if (b)
    c.body = cut(isLoginCode(o) ? hideDigits(c.body) : c.body);
  if (t)
    c.text = cut(c.text);
  if (th)
    c.thumb = cutUrl(c.thumb);
  return c;
}
var nest = (v) => Array.isArray(v) ? v.map(nest1) : nest1(v);
var nest1 = (v) => v && typeof v === "object" && !Array.isArray(v) ? trimOwn(v) : v;
function trimBodies(o) {
  const r = trimOwn(o);
  let c = r === o ? null : r;
  for (const k of ["items", "message", "result", "attachment"]) {
    const v = o[k];
    if (v && typeof v === "object") {
      c ??= { ...o };
      c[k] = nest(v);
    }
  }
  return c ?? o;
}

class DevLog {
  buf = new Array(LOG_CAP);
  epoch = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  next = 1;
  floor = 0;
  reqs = new Map;
  syncAt = 0;
  pingAt = 0;
  rtt = null;
  record(kind, type, data, size, ms) {
    const e = { id: this.next, ep: this.epoch, t: Date.now(), kind, type, data, size, ms };
    this.buf[(this.next - 1) % LOG_CAP] = e;
    this.next++;
    return e;
  }
  get lastId() {
    return this.next - 1;
  }
  get firstId() {
    return Math.max(this.floor + 1, this.next - LOG_CAP, 1);
  }
  get size() {
    return this.next - this.firstId;
  }
  since(cursor) {
    const out = [];
    for (let id = Math.max(cursor + 1, this.firstId);id < this.next; id++)
      out.push(this.buf[(id - 1) % LOG_CAP]);
    return out;
  }
  clear() {
    this.floor = this.next - 1;
  }
  error(where, err) {
    const e = err;
    this.record("error", where, {
      message: cutUrl(String(e?.message ?? e?.code ?? err)),
      ...typeof e?.stack === "string" ? { stack: e.stack.split(`
`).slice(1, 6).map((l) => cutUrl(l.trim())).join(`
`) } : {}
    });
  }
  frameOut(f, size) {
    const now = Date.now();
    if (f.op === "sync")
      this.syncAt = now;
    else if (f.op === "ping")
      this.pingAt = now;
    else if ("reqId" in f && f.reqId) {
      if (this.reqs.size > 1000)
        this.reqs.clear();
      this.reqs.set(f.reqId, now);
    }
    this.record("ws-out", f.op, f.op === "send" || f.op === "draft" || f.op === "edit" ? trimBodies(f) : f, size);
  }
  frameIn(f, size, note) {
    const now = Date.now();
    let ms;
    let data = f;
    switch (f.op) {
      case "updates": {
        const types = {};
        const items = f.items;
        let prev = "", run = 0;
        for (let i = 0;i < items.length; i++) {
          const k = items[i].update.type;
          if (k === prev) {
            run++;
            continue;
          }
          if (run)
            types[prev] = (types[prev] ?? 0) + run;
          prev = k;
          run = 1;
        }
        if (run)
          types[prev] = (types[prev] ?? 0) + run;
        data = { from: f.from, to: f.to, count: f.items.length, more: f.more, types };
        if (this.syncAt)
          ms = now - this.syncAt;
        break;
      }
      case "tooLong":
        if (this.syncAt)
          ms = now - this.syncAt;
        break;
      case "ack":
      case "err": {
        const at = f.reqId ? this.reqs.get(f.reqId) : undefined;
        if (at !== undefined) {
          ms = now - at;
          this.reqs.delete(f.reqId);
        }
        if (f.op === "ack")
          data = trimBodies(f);
        break;
      }
      case "pong":
        if (this.pingAt) {
          ms = this.rtt = now - this.pingAt;
          this.pingAt = 0;
        }
        break;
      case "presence":
        data = { count: f.items.length };
        break;
    }
    this.record("ws-in", note ? f.op + ":" + note : f.op, data, size, ms);
  }
  closed() {
    this.reqs.clear();
    this.syncAt = 0;
    this.pingAt = 0;
  }
}

class DevTools {
  db;
  hooks;
  log = new DevLog;
  sim = newSim();
  host = null;
  openedAt = Date.now();
  counters = { serverSeq: null, lastSyncAt: null, tooLongCount: 0 };
  fetch;
  watching = false;
  statsTimer = null;
  logTimer = null;
  statsDirty = false;
  logTick = false;
  logSeen = 0;
  passPatches = 0;
  statsAt = 0;
  idb = { at: 0, counts: null, loading: false };
  constructor(db, hooks) {
    this.db = db;
    this.hooks = hooks;
    const sim = simFetch(this.log, this.sim);
    this.fetch = hooks.wrapFetch ? hooks.wrapFetch(sim) : sim;
  }
  restore(s) {
    if (!s)
      return;
    this.sim.offline = !!s.offline;
    this.sim.profile = normProfile(s.profile ?? null);
    this.sim.persist = true;
  }
  get simActive() {
    return simActive(this.sim);
  }
  get lossy() {
    return lossy(this.sim);
  }
  track(watchers) {
    let stats = false, log = false;
    for (const w of watchers) {
      if (w.q.kind === "devStats")
        stats = true;
      else if (w.q.kind === "devLog")
        log = true;
    }
    this.watching = stats;
    if (stats && !this.statsTimer) {
      this.statsTimer = setInterval(() => {
        this.statsDirty = true;
        this.hooks.ping();
        this.refreshIdb();
        this.hooks.schedule();
      }, STATS_MS);
      this.refreshIdb();
    } else if (!stats && this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (log && !this.logTimer) {
      this.logTimer = setInterval(() => {
        if (this.log.lastId !== this.logSeen) {
          this.logTick = true;
          this.hooks.schedule();
        }
      }, LOG_MS);
    } else if (!log && this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }
  get idle() {
    return !this.statsTimer && !this.logTimer;
  }
  stop() {
    if (this.statsTimer)
      clearInterval(this.statsTimer);
    if (this.logTimer)
      clearInterval(this.logTimer);
    this.statsTimer = this.logTimer = null;
    this.watching = false;
  }
  get statsDue() {
    return this.statsDirty;
  }
  patched(w, p) {
    const s = w.stat ??= { n: 0, prevN: 0, rate: 0, bytes: null, bytesAt: 0, snapAt: 0 };
    s.n++;
    if (p.op === "snapshot")
      s.snapAt = Date.now();
    if (w.q.kind === "devStats")
      return;
    this.passPatches++;
    if (this.watching && Date.now() - s.bytesAt >= STATS_MS) {
      s.bytes = estimateBytes(p);
      s.bytesAt = Date.now();
    }
  }
  pushLog(w) {
    if (w.q.kind !== "devLog")
      return;
    let patch;
    const last = this.log.lastId;
    if (w.force) {
      w.force = false;
      const ev = this.log.since(w.q.since);
      w.first = ev.length ? ev[0].id : last + 1;
      w.cursor = last;
      patch = { op: "snapshot", items: ev.map(item), order: ev.map(keyOf) };
    } else {
      if (!this.logTick || last === w.cursor)
        return;
      const had = w.cursor ?? 0;
      const ev = this.log.since(had);
      w.cursor = last;
      const first = this.log.firstId, from = w.first ?? first;
      const remove = [];
      for (let id = from, to = Math.min(first, had + 1);id < to; id++)
        remove.push("e" + id);
      w.first = Math.max(from, first);
      patch = { op: "diff", upsert: ev.map(item), remove, append: true };
    }
    try {
      w.cb(patch);
    } catch (err) {
      this.log.error("devLog callback", err);
    }
  }
  afterEmit() {
    if (this.passPatches)
      this.log.record("engine", "patches", { count: this.passPatches });
    this.passPatches = 0;
    if (this.logTick) {
      this.logTick = false;
      this.logSeen = this.log.lastId;
    }
    this.statsDirty = false;
  }
  refreshIdb() {
    if (this.idb.loading || Date.now() - this.idb.at < IDB_TTL_MS)
      return;
    this.idb.loading = true;
    countStores(this.db).then((counts) => {
      this.idb = { at: Date.now(), counts, loading: false };
    }, () => {
      this.idb = { ...this.idb, at: Date.now(), loading: false };
    });
  }
  stats() {
    const now = Date.now();
    const dt = this.statsAt ? (now - this.statsAt) / 1000 : 0;
    this.statsAt = now;
    return buildStats(this.hooks.view(), { db: this.db, log: this.log, sim: this.sim, host: this.host, openedAt: this.openedAt, counters: this.counters, idb: this.idb.counts, dt });
  }
  async command(a) {
    this.log.record("engine", "dev:" + a.cmd, a.args ?? null);
    switch (a.cmd) {
      case "offline":
        this.sim.offline = a.args.on;
        if (a.args.persist !== undefined)
          this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        this.hooks.offline(a.args.on);
        return null;
      case "netProfile":
        this.sim.profile = normProfile(a.args.profile);
        if (a.args.persist !== undefined)
          this.sim.persist = a.args.persist;
        saveSim(this.db, this.sim);
        return null;
      case "persist":
        this.sim.persist = a.args.on;
        saveSim(this.db, this.sim);
        return null;
      case "dropSocket":
        this.hooks.dropSocket();
        return null;
      case "dropNextUpdates":
        this.sim.dropNextUpdates = true;
        return null;
      case "forceTooLong":
        this.sim.forceTooLong = true;
        this.hooks.sync();
        return null;
      case "resync":
        await this.hooks.resync();
        return null;
      case "restartWorker":
        return this.hooks.restart();
      case "retryFailed":
        return { count: await this.hooks.retryFailed() };
      case "discardFailed":
        return { count: await this.hooks.discardFailed() };
      case "clearLog":
        this.log.clear();
        return null;
      case "idbRead":
        return readStore(this.db, a.args);
    }
  }
}
var keyOf = (e) => "e" + e.id;
var item = (e) => ({ key: "e" + e.id, ...e });

// packages/sync-engine/src/devstats.ts
var EWMA = 0.5;
var SAMPLE = 8;
function estimateBytes(p) {
  const items = p.op === "snapshot" ? p.items : p.upsert;
  let n = 0;
  const k = Math.min(items.length, SAMPLE);
  for (let i = 0;i < k; i++)
    n += JSON.stringify(items[i]).length;
  const itemsBytes = items.length > k ? Math.round(n / k * items.length) : n;
  const keys = (p.op === "diff" ? p.remove.length : 0) + (p.order?.length ?? 0);
  return itemsBytes + keys * 12 + 40;
}
function subKey(q) {
  switch (q.kind) {
    case "messages":
      return "messages:" + q.chatId;
    case "presence":
      return "presence:" + q.userId;
    case "user":
      return "user:" + q.userId;
    default:
      return q.kind;
  }
}
function buildStats(v, o) {
  const now = Date.now();
  let pending = 0, failed = 0;
  const byChat = {};
  for (const e of v.outbox) {
    const c = byChat[e.chatId] ??= { pending: 0, failed: 0 };
    if (e.failed) {
      failed++;
      c.failed++;
    } else {
      pending++;
      c.pending++;
    }
  }
  const subs = [];
  for (const w of v.watchers) {
    const s = w.stat;
    if (s && o.dt > 0) {
      s.rate = EWMA * ((s.n - s.prevN) / o.dt) + (1 - EWMA) * s.rate;
      s.prevN = s.n;
    }
    subs.push({
      id: w.id,
      kind: w.q.kind,
      key: subKey(w.q),
      items: w.q.kind === "devLog" ? Math.max(0, (w.cursor ?? 0) - (w.first ?? 1) + 1) : w.prev?.order.length ?? 0,
      patchesPerSec: s ? Math.round(s.rate * 10) / 10 : 0,
      lastPatchBytes: s?.bytes ?? null,
      sinceSnapshotMs: s?.snapAt ? now - s.snapAt : null
    });
  }
  const { serverSeq, lastSyncAt, tooLongCount } = o.counters;
  const { host: h, sim } = o;
  return {
    key: "devStats",
    at: now,
    build: h?.build ?? null,
    epoch: v.epoch,
    userId: v.userId,
    idbVersion: o.db.version,
    host: h ? { kind: h.kind, clients: h.clients(), uptimeMs: now - h.startedAt } : null,
    engineUptimeMs: now - o.openedAt,
    logEpoch: o.log.epoch,
    pingMs: o.log.rtt,
    sync: {
      lastSeq: v.lastSeq,
      serverSeq,
      lag: serverSeq == null ? null : Math.max(0, serverSeq - v.lastSeq),
      phase: v.phase,
      ready: v.ready,
      syncing: v.syncing,
      lastSyncAt,
      tooLongCount
    },
    socket: v.socket,
    queues: { outbox: { pending, failed, byChat }, pendingReads: v.pendingReads, ops: v.ops },
    subscriptions: subs,
    idb: o.idb,
    log: { size: o.log.size, lastId: o.log.lastId, cap: LOG_CAP },
    sim: { offline: sim.offline, profile: sim.profile, dropNextUpdates: sim.dropNextUpdates, forceTooLong: sim.forceTooLong, persist: sim.persist, active: simActive(sim) }
  };
}
function countStores(db) {
  return new Promise((resolve, reject) => {
    const names = STORES.filter((s) => db.objectStoreNames.contains(s));
    const t = db.transaction(names);
    const out = Object.fromEntries(STORES.map((s) => [s, 0]));
    for (const s of names) {
      const r = t.objectStore(s).count();
      r.onsuccess = () => {
        out[s] = r.result;
      };
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// packages/sync-engine/src/profileLists.ts
var PROFILE_LIST_MAX = 100;
var OP_MUSIC = "music:";
var musicKey = (attId) => OP_MUSIC + attId;

class PerUser {
  id;
  table = new Table;
  byUser = new Map;
  constructor(id) {
    this.id = id;
  }
  key(r) {
    return r.userId + ":" + this.id(r);
  }
  load(rows) {
    this.table.load(rows, (r) => this.key(r));
    for (const r of rows)
      this.keys(r.userId).add(this.key(r));
  }
  keys(userId) {
    let s = this.byUser.get(userId);
    if (!s) {
      s = new Set;
      this.byUser.set(userId, s);
    }
    return s;
  }
  rows(userId) {
    return [...this.byUser.get(userId) ?? []].map((k) => this.table.get(k)).filter(Boolean);
  }
  apply(userId, list) {
    const keep = new Set;
    let changed = false;
    for (const r of list) {
      const k = this.key(r);
      keep.add(k);
      this.keys(userId).add(k);
      if (this.table.put(k, r, 0))
        changed = true;
    }
    for (const k of [...this.byUser.get(userId) ?? []])
      if (!keep.has(k)) {
        this.table.delete(k);
        this.byUser.get(userId).delete(k);
        changed = true;
      }
    return changed;
  }
  drop(userId, max = 0, newer) {
    let list = this.rows(userId);
    if (newer)
      list = list.sort(newer).slice(max);
    for (const r of list) {
      const k = this.key(r);
      this.table.delete(k);
      this.byUser.get(userId)?.delete(k);
    }
    if (!this.byUser.get(userId)?.size)
      this.byUser.delete(userId);
    return list.length;
  }
  users() {
    return [...this.byUser.keys()];
  }
  collect(num) {
    const { put, del } = this.table.collect();
    return { put, del: del.map((k) => {
      const i = k.indexOf(":"), id = k.slice(i + 1);
      return [Number(k.slice(0, i)), num ? Number(id) : id];
    }) };
  }
  clear() {
    this.table.clear();
    this.byUser.clear();
  }
}
function summarySig(store, kind, userId) {
  const u = userId === store.userId ? store.profile.me : store.users.get(userId);
  if (!u)
    return;
  if (kind === "m")
    return u.music ? u.music.count + ":" + u.music.top.id : "0";
  return u.photo ? String(u.photo.pid ?? u.photo.id) : "";
}
var tracksSig = (t) => t.length ? t.length + ":" + t[0].id : "0";

class ProfileLists {
  music = new PerUser((r) => r.attId);
  photos = new PerUser((r) => r.pid);
  touched = new Set;
  loading = new Set;
  marks = new Map;
  totals = new Map;
  gens = new Map;
  persist = false;
  static async load(db, meta) {
    const c = new ProfileLists;
    c.music.load(await getAll(db, "profileMusic"));
    c.photos.load(await getAll(db, "profilePhotos"));
    const v = meta.find((m) => m.k === "profileLists")?.v;
    for (const [k, s] of v?.marks ?? [])
      c.marks.set(k, s);
    for (const [id, n] of v?.totals ?? [])
      c.totals.set(id, n);
    return c;
  }
  loaded(tag) {
    return this.marks.has(tag);
  }
  gen(tag) {
    return this.gens.get(tag) ?? 0;
  }
  total(userId) {
    return this.totals.get(userId) ?? null;
  }
  stale(store, kind, userId) {
    const tag = kind + ":" + userId, cur = summarySig(store, kind, userId);
    return this.marks.has(tag) && cur !== undefined && this.marks.get(tag) !== cur;
  }
  based(tag, sig) {
    this.gens.set(tag, this.gen(tag) + 1);
    this.marks.set(tag, sig);
    this.persist = true;
    this.touched.add(tag);
  }
  applyMusic(userId, tracks, sig = tracksSig(tracks)) {
    this.music.apply(userId, tracks.slice(0, PROFILE_LIST_MAX).map((t) => ({ userId, attId: t.id, title: t.title, duration: t.duration ?? null, mime: t.mime, addedAt: t.addedAt })));
    this.based("m:" + userId, sig);
  }
  applyPhotos(userId, photos, total, sig) {
    this.photos.apply(userId, photos.slice(0, PROFILE_LIST_MAX).map((p) => ({ userId, pid: p.pid, id: p.id, small: p.small, thumb: p.thumb, at: p.at, ...p.video ? { video: p.video } : {} })));
    this.totals.set(userId, total);
    this.based("p:" + userId, sig);
  }
  invalidate(tag) {
    if (this.marks.has(tag))
      this.marks.set(tag, "\x00stale");
  }
  noteSummary(kind, userId) {
    this.touched.add(kind + ":" + userId);
  }
  collect() {
    const meta = this.persist ? { k: "profileLists", v: { marks: [...this.marks], totals: [...this.totals] } } : null;
    this.persist = false;
    return { music: this.music.collect(false), photos: this.photos.collect(true), meta };
  }
  dropUser(userId) {
    const had = this.music.drop(userId) + this.photos.drop(userId);
    for (const tag of ["m:" + userId, "p:" + userId])
      if (this.marks.delete(tag)) {
        this.persist = true;
        this.touched.add(tag);
      }
    if (this.totals.delete(userId))
      this.persist = true;
    if (had) {
      this.touched.add("m:" + userId);
      this.touched.add("p:" + userId);
    }
  }
  cap(max = PROFILE_LIST_MAX) {
    let n = 0;
    for (const id of this.music.users()) {
      const k = this.music.drop(id, max, (a, b) => a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0);
      if (k) {
        n += k;
        this.touched.add("m:" + id);
      }
    }
    for (const id of this.photos.users()) {
      const k = this.photos.drop(id, max, (a, b) => b.at - a.at);
      if (k) {
        n += k;
        this.touched.add("p:" + id);
      }
    }
    return n;
  }
  reset() {
    for (const k of [...this.marks.keys(), ...this.loading])
      this.touched.add(k);
    this.music.clear();
    this.photos.clear();
    this.marks.clear();
    this.totals.clear();
    this.loading.clear();
    for (const k of this.gens.keys())
      this.gens.set(k, this.gen(k) + 1);
  }
}
function noteSummaries(store, userId, before) {
  if (summarySig(store, "m", userId) !== before[0])
    store.profileLists.noteSummary("m", userId);
  if (summarySig(store, "p", userId) !== before[1])
    store.profileLists.noteSummary("p", userId);
}
function musicView(base, ops, userId) {
  const view = new Map(base.map((r) => [r.attId, { ...r, pending: false }]));
  for (const op of ops) {
    if (!op.key.startsWith(OP_MUSIC))
      continue;
    const attId = op.key.slice(OP_MUSIC.length);
    if (op.method === "DELETE") {
      view.delete(attId);
      continue;
    }
    const t = op.body?.track;
    if (t && !view.has(attId))
      view.set(attId, { userId, attId, title: t.title, duration: t.duration, mime: t.mime, addedAt: new Date(op.at).toISOString(), pending: true });
  }
  return [...view.values()].sort((a, b) => a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.attId < b.attId ? 1 : -1).slice(0, PROFILE_LIST_MAX);
}
function result2(list) {
  return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
}
function profileMusicResult(store, userId, ops, loading) {
  const rows = store.profileLists.music.rows(userId);
  const list = musicView(rows, userId === store.userId ? ops : [], userId).map((r) => ({ key: r.attId, attId: r.attId, title: r.title, duration: r.duration, mime: r.mime, addedAt: r.addedAt, pending: r.pending }));
  list.push({ key: "~profileMusic", loaded: store.profileLists.loaded("m:" + userId), loading });
  return result2(list);
}
function profilePhotosResult(store, userId, me, loading) {
  const u = userId === store.userId ? me : store.users.get(userId);
  const main = u?.photo?.pid;
  const rows = store.profileLists.photos.rows(userId).sort((a, b) => Number(b.pid === main) - Number(a.pid === main) || b.at - a.at || b.pid - a.pid);
  const list = rows.slice(0, PROFILE_LIST_MAX).map((r) => ({ key: String(r.pid), pid: r.pid, id: r.id, small: r.small, thumb: r.thumb, at: r.at, ...r.video ? { video: r.video } : {} }));
  list.push({ key: "~profilePhotos", loaded: store.profileLists.loaded("p:" + userId), loading, total: store.profileLists.total(userId) });
  return result2(list);
}
var kindOf = (q) => q.kind === "profileMusic" ? "m" : "p";

class ProfileListsLoader {
  store;
  deps;
  asked = new Set;
  redo = new Set;
  constructor(store, deps) {
    this.store = store;
    this.deps = deps;
  }
  loading(q) {
    return this.store.profileLists.loading.has(kindOf(q) + ":" + q.userId);
  }
  refreshPhotos(userId) {
    const tag = "p:" + userId;
    this.store.profileLists.invalidate(tag);
    for (const k of [...this.asked])
      if (k.startsWith(tag + "|"))
        this.asked.delete(k);
    if (this.store.profileLists.loading.has(tag)) {
      this.redo.add(tag);
      return;
    }
    this.want({ kind: "profilePhotos", userId });
  }
  forgetUser(userId) {
    for (const k of [...this.asked])
      if (k.startsWith("m:" + userId + "|") || k.startsWith("p:" + userId + "|"))
        this.asked.delete(k);
  }
  reconnect() {
    this.asked.clear();
  }
  want(q) {
    const lists = this.store.profileLists, kind = kindOf(q), userId = q.userId, tag = kind + ":" + userId;
    if (!this.deps.online() || lists.loading.has(tag))
      return;
    if (lists.loaded(tag) && !lists.stale(this.store, kind, userId))
      return;
    const sig = summarySig(this.store, kind, userId) ?? null;
    const asked = tag + "|" + sig;
    if (this.asked.has(asked))
      return;
    this.asked.add(asked);
    lists.loading.add(tag);
    lists.touched.add(tag);
    const gen = lists.gen(tag), reset = this.store.resetGen;
    const fresh = () => lists.gen(tag) === gen && this.store.resetGen === reset;
    this.deps.run(async () => {
      try {
        if (kind === "m") {
          const r = await this.deps.http(`/users/${userId}/music`);
          if (fresh())
            lists.applyMusic(userId, r.tracks, sig);
        } else {
          const r = await this.deps.http(`/users/${userId}/photos?limit=${PROFILE_LIST_MAX}`);
          if (fresh())
            lists.applyPhotos(userId, r.photos, r.total, sig);
        }
        await this.store.flush();
      } finally {
        lists.loading.delete(tag);
        lists.touched.add(tag);
        this.deps.changed();
        if (this.redo.delete(tag))
          this.refreshPhotos(userId);
      }
    });
  }
  opDone(op, value) {
    if (!op.key.startsWith(OP_MUSIC))
      return false;
    const v = value;
    if (v && Array.isArray(v.tracks)) {
      this.store.profileLists.applyMusic(this.store.userId, v.tracks);
      this.deps.run(() => this.store.flush());
    }
    return true;
  }
}
function trackOf(store, chatId, messageId) {
  const a = store.messageById(chatId, messageId)?.attachment;
  if (!a || a.kind !== "audio")
    return null;
  return { id: a.id, title: a.name.replace(/\.[^.]{1,5}$/, "").slice(0, 200), duration: a.duration ?? null, mime: a.mime };
}

// packages/sync-engine/src/profile.ts
var OP_PROFILE = "profile";
var OP_USERNAME = "username";
var OP_LINKS = "links";
var OP_PCHANNEL = "pchannel";

class ProfileCache {
  userId;
  me = null;
  users = new Table;
  dirty = false;
  gen = 0;
  dirtyMe = false;
  constructor(userId) {
    this.userId = userId;
  }
  static async load(db, userId, meta) {
    const p = new ProfileCache(userId);
    p.me = meta.find((m) => m.k === "me")?.v ?? null;
    p.users.load(await getAll(db, "users"), (u) => u.id);
    return p;
  }
  setMe(me) {
    const cur = this.me?.seq;
    if (me.seq !== undefined && cur !== undefined && me.seq < cur)
      return false;
    if (this.me && JSON.stringify({ ...this.me, seq: undefined }) === JSON.stringify({ ...me, seq: undefined })) {
      if (me.seq !== undefined && me.seq !== cur) {
        this.me = me;
        this.dirtyMe = true;
      }
      return false;
    }
    this.me = me;
    this.gen++;
    this.dirtyMe = true;
    this.dirty = true;
    return true;
  }
  applyUser(u, seq) {
    if (u.id === this.userId) {
      if (seq !== undefined && this.me?.seq !== undefined && seq <= this.me.seq)
        return;
      this.setMe({ userId: u.id, name: u.name, firstName: u.firstName, lastName: u.lastName, username: u.username, bio: u.bio, birthday: u.birthday, links: u.links ?? [], photo: u.photo ?? null, personalChannel: u.personalChannel ?? null, phone: u.phone ?? this.me?.phone ?? null, seq: seq ?? this.me?.seq });
      return;
    }
    const prev = this.users.get(u.id);
    if (this.users.put(u.id, u, seq ?? prev?.seq ?? 0))
      this.dirty = true;
  }
  applyPeer(p, seq = 0) {
    if (p.id === this.userId)
      return;
    const prev = this.users.get(p.id);
    let base;
    if (prev) {
      const { seq: _s, v: _v, ...rest } = prev;
      base = rest;
    } else {
      const sp = p.name.indexOf(" ");
      base = { id: p.id, name: p.name, firstName: sp < 0 ? p.name : p.name.slice(0, sp), lastName: sp < 0 ? "" : p.name.slice(sp + 1), username: null, bio: null, birthday: null, phone: null, links: [] };
    }
    const next = { ...base, name: p.name, photo: p.photo !== undefined ? p.photo : base.photo ?? null };
    if (p.username !== undefined)
      next.username = p.username;
    if (p.system)
      next.system = true;
    if (p.key)
      next.key = p.key;
    if (this.users.put(p.id, next, seq))
      this.dirty = true;
  }
  collect() {
    const { put, del } = this.users.collect();
    const out = { me: this.dirtyMe && this.me ? { k: "me", v: this.me } : null, users: put, del };
    this.dirtyMe = false;
    return out;
  }
  reset() {
    this.me = null;
    this.users.clear();
    this.dirtyMe = false;
    this.gen++;
    this.dirty = true;
  }
}
function applyUserUpdated(store, u, seq) {
  const before = [summarySig(store, "m", u.id), summarySig(store, "p", u.id)];
  store.profile.applyUser(u, seq);
  noteSummaries(store, u.id, before);
}
var cleanBio = (s) => s == null ? null : cleanText(s) || null;
var cleanUsername = (s) => s ? s.trim().replace(/^@/, "").toLowerCase() || null : null;
function meView(base, ops) {
  if (!base)
    return null;
  let me = base;
  for (const op of ops) {
    if (op.key === OP_PROFILE) {
      const b = op.body ?? {};
      me = { ...me };
      if (b.firstName !== undefined)
        me.firstName = cleanName(b.firstName);
      if (b.lastName !== undefined)
        me.lastName = cleanName(b.lastName ?? "");
      if (b.bio !== undefined)
        me.bio = cleanBio(b.bio);
      if (b.birthday !== undefined)
        me.birthday = b.birthday;
      me.name = `${me.firstName} ${me.lastName}`.trim();
    } else if (op.key === OP_LINKS) {
      me = { ...me, links: op.body.links };
    } else if (op.key === OP_PCHANNEL) {
      me = { ...me, personalChannel: op.body.channel };
    } else if (op.key === OP_USERNAME) {
      me = { ...me, username: cleanUsername(op.body.username) };
    }
  }
  return me;
}
function meItem(me) {
  if (!me)
    return [];
  const { seq: _seq, ...rest } = me;
  return [{ key: "me", ...rest }];
}
function userItem(p, me, userId) {
  if (userId === p.userId) {
    return me ? [{ key: "u" + userId, id: me.userId, name: me.name, firstName: me.firstName, lastName: me.lastName, username: me.username, bio: me.bio, birthday: me.birthday, phone: me.phone, links: me.links ?? [], personalChannel: me.personalChannel ?? null }] : [];
  }
  const u = p.users.get(userId);
  if (!u)
    return [];
  const { seq: _seq, v: _v, ...rest } = u;
  return [{ key: "u" + userId, ...rest }];
}

// packages/sync-engine/src/settings.ts
var OP_NOTIFY = "notify:";
var notifyKey = (t) => OP_NOTIFY + t;
var notifyTypeOf = (key) => key === OP_NOTIFY + "direct" ? "direct" : key === OP_NOTIFY + "group" ? "group" : null;
var OP_PRIVACY = "privacy:";
var privacyKey = (k) => OP_PRIVACY + k;
var privacyKeyOf = (key) => {
  if (!key.startsWith(OP_PRIVACY))
    return null;
  const k = key.slice(OP_PRIVACY.length);
  return PRIVACY_KEYS.includes(k) ? k : null;
};
var OP_FOLDER = "folder:";
var folderKey = (id) => OP_FOLDER + id;
var OP_FOLDERS_ORDER = "folders:order";
var folderIdOf = (key) => {
  if (!key.startsWith(OP_FOLDER))
    return null;
  const id = Number(key.slice(OP_FOLDER.length));
  return Number.isSafeInteger(id) ? id : null;
};
function orderFolders(folders, ids) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = [];
  for (const x of ids) {
    const f = typeof x === "number" ? byId.get(x) : undefined;
    if (f) {
      out.push(f);
      byId.delete(x);
    }
  }
  return [...out, ...folders.filter((f) => byId.has(f.id))];
}
var defaultSettings = () => ({
  notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true }, channel: { muted: false, preview: true } },
  sessionsTtlDays: 180,
  folders: [],
  privacy: defaultPrivacy()
});
var MODES = ["everyone", "contacts", "nobody"];
var idList = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "number" && Number.isSafeInteger(x)) : [];
function normalizeRule(k, r) {
  const d = defaultPrivacy()[k];
  const v = r;
  if (!v || typeof v !== "object")
    return d;
  return { mode: MODES.includes(v.mode) ? v.mode : d.mode, allow: idList(v.allow), deny: idList(v.deny) };
}
function normalizePrivacy(p) {
  const out = defaultPrivacy();
  const v = p;
  if (v && typeof v === "object") {
    for (const k of PRIVACY_KEYS)
      if (v[k] !== undefined)
        out[k] = normalizeRule(k, v[k]);
  }
  return out;
}
function normalizeSettings(s) {
  const d = defaultSettings();
  for (const t of ["direct", "group", "channel"]) {
    const v = s?.notify?.[t];
    if (typeof v?.muted === "boolean")
      d.notify[t].muted = v.muted;
    if (typeof v?.preview === "boolean")
      d.notify[t].preview = v.preview;
  }
  if (typeof s?.sessionsTtlDays === "number")
    d.sessionsTtlDays = s.sessionsTtlDays;
  d.folders = normalizeFolders(s?.folders);
  d.privacy = normalizePrivacy(s?.privacy);
  return d;
}

class SettingsCache {
  base = defaultSettings();
  loaded = false;
  seq = 0;
  dirty = false;
  persist = false;
  static load(meta) {
    const c = new SettingsCache;
    const v = meta.find((m) => m.k === "settings")?.v;
    if (v) {
      c.base = normalizeSettings(v.base);
      c.seq = v.seq;
      c.loaded = true;
    }
    return c;
  }
  apply(s, seq) {
    if (seq !== undefined && seq < this.seq)
      return false;
    const next = normalizeSettings({ ...s, privacy: s.privacy ?? this.base.privacy, folders: s.folders ?? this.base.folders });
    if (this.loaded && JSON.stringify(next) === JSON.stringify(this.base)) {
      if (seq !== undefined && seq > this.seq) {
        this.seq = seq;
        this.persist = true;
      }
      return false;
    }
    if (seq !== undefined)
      this.seq = seq;
    this.base = next;
    this.loaded = true;
    this.dirty = true;
    this.persist = true;
    return true;
  }
  collect() {
    if (!this.persist)
      return null;
    this.persist = false;
    return { k: "settings", v: { base: this.base, seq: this.seq } };
  }
  applyPrivacy(rules, seq) {
    return this.apply({ notify: this.base.notify, sessionsTtlDays: this.base.sessionsTtlDays, folders: this.base.folders, privacy: rules }, seq);
  }
  reset() {
    this.base = defaultSettings();
    this.seq = 0;
    this.loaded = false;
    this.dirty = true;
    this.persist = false;
  }
}
function settingsView(base, ops) {
  let notify = base.notify;
  let privacy = base.privacy;
  let ttl = base.sessionsTtlDays;
  let folders = base.folders;
  for (const op of ops) {
    if (op.key === OP_FOLDERS_ORDER) {
      const ids = op.body?.ids;
      if (Array.isArray(ids))
        folders = orderFolders(folders, ids);
      continue;
    }
    const fid = folderIdOf(op.key);
    if (fid !== null) {
      if (op.method === "DELETE") {
        folders = folders.filter((f) => f.id !== fid);
        continue;
      }
      const f = normalizeFolder({ ...op.body, id: fid });
      if (!f)
        continue;
      const i = folders.findIndex((x) => x.id === fid);
      if (i >= 0)
        folders = folders.map((x, k) => k === i ? f : x);
      else if (folders.length < FOLDER_LIMITS.folders)
        folders = [...folders, f];
      continue;
    }
    if (op.key === OP_SESSIONS_TTL) {
      const d = op.body?.days;
      if (typeof d === "number")
        ttl = d;
      continue;
    }
    const pk = privacyKeyOf(op.key);
    if (pk && privacy) {
      privacy = { ...privacy, [pk]: normalizeRule(pk, op.body) };
      continue;
    }
    const t = notifyTypeOf(op.key);
    if (!t)
      continue;
    const b = op.body ?? {};
    const cur = notify[t];
    notify = { ...notify, [t]: { muted: typeof b.muted === "boolean" ? b.muted : cur.muted, preview: typeof b.preview === "boolean" ? b.preview : cur.preview } };
  }
  return notify === base.notify && privacy === base.privacy && ttl === base.sessionsTtlDays && folders === base.folders ? base : { ...base, notify, privacy, sessionsTtlDays: ttl, folders };
}
function settingsItem(view, loaded, pending) {
  return [{ key: "settings", notify: view.notify, sessionsTtlDays: view.sessionsTtlDays, folders: view.folders, privacy: view.privacy, loaded, pending }];
}
function isNotifyOp(op) {
  return notifyTypeOf(op.key) !== null || privacyKeyOf(op.key) !== null || op.key === OP_SESSIONS_TTL || op.key === OP_FOLDERS_ORDER || folderIdOf(op.key) !== null;
}

// packages/sync-engine/src/members.ts
var MEMBERS_FULL = 1000;
var MEMBERS_PART = 200;
var keyOf2 = (chatId, userId) => chatId + ":" + userId;

class MembersCache {
  table = new Table;
  touched = new Set;
  byChat = new Map;
  sorted = new Map;
  revs = new Map;
  gone = new Map;
  loading = new Set;
  static async load(db, chatSeq) {
    const c = new MembersCache;
    const rows = await getAll(db, "members");
    for (const r of rows)
      r.seq = Math.min(r.seq, chatSeq.get(r.chatId) ?? 0);
    c.table.load(rows, (x) => keyOf2(x.chatId, x.userId));
    for (const r of rows)
      c.keys(r.chatId).add(keyOf2(r.chatId, r.userId));
    return c;
  }
  keys(chatId) {
    let s = this.byChat.get(chatId);
    if (!s) {
      s = new Set;
      this.byChat.set(chatId, s);
    }
    return s;
  }
  touch(chatId) {
    this.touched.add(chatId);
    this.sorted.delete(chatId);
  }
  list(chatId) {
    let arr = this.sorted.get(chatId);
    if (!arr) {
      arr = [...this.byChat.get(chatId) ?? []].map((k) => this.table.get(k)).filter(Boolean).sort((a, b) => a.order - b.order);
      this.sorted.set(chatId, arr);
    }
    return arr;
  }
  rev(chatId) {
    return this.revs.get(chatId) ?? 0;
  }
  bump(chatId) {
    this.revs.set(chatId, this.rev(chatId) + 1);
  }
  put(chatId, m, order, seq) {
    const k = keyOf2(chatId, m.userId);
    if ((this.gone.get(k) ?? 0) > seq)
      return false;
    if (!this.table.put(k, { chatId, userId: m.userId, role: m.role, rank: m.rank ?? null, order }, seq))
      return false;
    this.gone.delete(k);
    this.keys(chatId).add(k);
    return true;
  }
  remove(chatId, userId, seq) {
    const k = keyOf2(chatId, userId);
    if ((this.table.get(k)?.seq ?? 0) > seq)
      return false;
    if (seq)
      this.gone.set(k, Math.max(this.gone.get(k) ?? 0, seq));
    this.byChat.get(chatId)?.delete(k);
    return this.table.delete(k);
  }
  applySnapshot(chatId, list, seq) {
    const ids = new Set(list.map((m) => m.userId));
    let changed = false;
    const reorder = (k, order) => {
      const r = this.table.get(k);
      if (r && r.order !== order && this.table.put(k, { chatId, userId: r.userId, role: r.role, rank: r.rank, order }, r.seq))
        changed = true;
    };
    list.forEach((m, i) => {
      if (this.put(chatId, m, i, seq))
        changed = true;
      else
        reorder(keyOf2(chatId, m.userId), i);
    });
    for (const r of this.list(chatId))
      if (!ids.has(r.userId) && this.remove(chatId, r.userId, seq))
        changed = true;
    this.sorted.delete(chatId);
    let tail = list.length;
    for (const r of this.list(chatId))
      if (!ids.has(r.userId))
        reorder(keyOf2(chatId, r.userId), tail++);
    if (changed)
      this.touch(chatId);
  }
  applyDelta(chatId, upsert, remove, seq) {
    let changed = false;
    for (const id of remove)
      if (this.remove(chatId, id, seq))
        changed = true;
    let max = this.list(chatId).reduce((n, r) => Math.max(n, r.order), -1);
    for (const m of upsert) {
      const prev = this.table.get(keyOf2(chatId, m.userId));
      if (this.put(chatId, m, prev ? prev.order : ++max, seq))
        changed = true;
    }
    if (changed)
      this.touch(chatId);
  }
  dropChat(chatId) {
    const keys = this.byChat.get(chatId);
    if (!keys?.size)
      return;
    for (const k of keys)
      this.table.delete(k);
    this.byChat.delete(chatId);
    this.touch(chatId);
  }
  trim(chatId, n) {
    const extra = this.list(chatId).slice(n);
    for (const r of extra) {
      const k = keyOf2(chatId, r.userId);
      this.byChat.get(chatId)?.delete(k);
      this.table.delete(k);
    }
    if (extra.length)
      this.touch(chatId);
    return extra.length;
  }
  collect() {
    const { put, del } = this.table.collect();
    return { put, del: del.map((k) => {
      const [c, u] = k.split(":");
      return [Number(c), Number(u)];
    }) };
  }
  reset() {
    for (const id of this.byChat.keys())
      this.touched.add(id);
    this.table.clear();
    this.byChat.clear();
    this.sorted.clear();
    this.gone.clear();
    this.revs.clear();
    this.loading.clear();
  }
}
function applyMembersReply(store, chatId, r, seq, chatAt = 0) {
  store.members.loading.delete(chatId);
  const chat = store.chats.get(chatId);
  if (!chat)
    return;
  const done = Math.max(r.members.length, chat.group?.members ?? 0) <= MEMBERS_FULL;
  const list = done ? r.members : r.members.slice(0, MEMBERS_PART);
  store.members.applySnapshot(chatId, list.map((m) => ({ userId: m.userId, role: m.role ?? "member", rank: m.rank ?? null })), chatAt);
  for (const m of list)
    store.profile.applyPeer({ id: m.userId, key: m.key, name: m.name, username: m.username, photo: m.photo ?? null }, seq);
  if (chat.membersDone !== done) {
    chat.membersDone = done;
    store.markChat(chat);
  }
  store.members.touched.add(chatId);
}
function applyMembersUpdate(store, chatId, upsert, remove, seq = 0) {
  const chat = store.chats.get(chatId);
  store.members.bump(chatId);
  store.retouch(chatId);
  if (!chat || chat.membersDone === undefined && !store.members.loading.has(chatId))
    return;
  if (remove.includes(store.userId)) {
    store.members.loading.delete(chatId);
    store.members.dropChat(chatId);
    delete chat.membersDone;
    store.markChat(chat);
    return;
  }
  store.members.applyDelta(chatId, upsert, remove, seq);
}
function membersResult(store, chatId, presence, me) {
  const items = new Map, sig = new Map, order = [];
  for (const r of store.members.list(chatId)) {
    const key = String(r.userId);
    let name, photo, g, p;
    if (r.userId === store.userId) {
      name = me?.name ?? "";
      photo = me?.photo ?? null;
      g = "me:" + JSON.stringify([name, photo]);
      p = { online: true, lastSeen: null };
    } else {
      const v = personView(store, r.userId);
      if (!store.users.get(r.userId))
        store.wantUser(r.userId);
      name = v.name;
      photo = v.photo;
      g = v.sig;
      p = presence.get(r.userId);
    }
    const online = p?.online ?? false, lastSeen = p?.lastSeen ?? null;
    const username = (r.userId === store.userId ? me?.username : store.users.get(r.userId)?.username) ?? null;
    items.set(key, { key, userId: r.userId, role: r.role, rank: r.rank, name, username, photo, online, lastSeen });
    sig.set(key, `${r.v}|${g}|${username}|${online}|${lastSeen}`);
    order.push(key);
  }
  const done = store.chats.get(chatId)?.membersDone;
  const meta = { key: "~members", loaded: done !== undefined, complete: done === true };
  items.set(meta.key, meta);
  sig.set(meta.key, `${meta.loaded}|${meta.complete}`);
  order.push(meta.key);
  return { items, order, sig };
}

// packages/sync-engine/src/store.ts
function sameDraft(a, b) {
  const key = (d) => d ? d.text + "\x00" + (d.entities ?? []).map((e) => [e.type, e.offset, e.length, e.url ?? ""].join(":")).sort().join("|") : "";
  return key(a) === key(b);
}
var pendingPoll = (p) => ({
  question: p.question,
  options: p.options.map((text, i) => ({ id: i + 1, text })),
  multiple: p.multiple,
  quiz: p.quiz,
  anonymous: p.anonymous,
  closed: false,
  closesAt: p.closesIn ? new Date(Date.now() + p.closesIn * 1000).toISOString() : null,
  voters: 0,
  counts: p.options.map(() => 0)
});
var deletedQuote = (id, senderId) => ({ id, sort: id, body: "", senderId, kind: "text", deleted: true, attachment: null, todo: null, article: false });
var GUEST_UPDATES = new Set(["messageEdited", "messageMarkup", "messageDeleted", "reactions", "reactionCounts", "linkPreview", "todoUpdated", "pollUpdated", "attachmentUpdated", "mediaListened"]);
var NOTIFY_KEEP = 20;
var DELETED = {
  body: "",
  deleted: true,
  reactions: [],
  entities: [],
  attachment: null,
  link: null,
  blocks: null,
  fwdFrom: null,
  todo: undefined,
  listened: undefined,
  buttons: null,
  reactionCounts: undefined,
  myReaction: undefined,
  expiresAt: undefined
};
function extendLive(chat, sort, own = false) {
  const ranges = chat.ranges, n = ranges.length, last = ranges[n - 1];
  if (!last)
    ranges.push([sort, sort]);
  else if (sort > last[1])
    last[1] = sort;
  else if (own && chat.seed != null && sort < last[0] && (n < 2 || sort > ranges[n - 2][1]))
    last[0] = sort;
  if (sort === chat.snapLast?.sort)
    delete chat.snapLast;
}
function snapshotLive(chat, m) {
  const sort = m.sort, last = chat.ranges[chat.ranges.length - 1];
  if (!last) {
    chat.ranges.push([sort, sort]);
    chat.seed = sort;
    return true;
  }
  if (sort <= last[1])
    return true;
  if (sort >= (chat.snapLast?.sort ?? 0))
    chat.snapLast = m;
  return false;
}
function addPage(ranges, lo, hi, at, dir, end) {
  const i = at == null ? -1 : ranges.findIndex((r) => r[0] <= at && at <= r[1]);
  let span = i >= 0 ? [ranges[i][0], ranges[i][1]] : null;
  if (lo != null)
    span = !span ? [lo, hi] : dir === "older" ? [Math.min(span[0], lo), span[1]] : [span[0], Math.max(span[1], hi)];
  if (!span)
    return ranges;
  const out = [];
  for (const r of ranges) {
    const below = r[1] < span[0] && !(end && dir === "older"), above = r[0] > span[1] && !(end && dir === "newer");
    if (below || above)
      out.push(r);
    else
      span = [Math.min(span[0], r[0]), Math.max(span[1], r[1])];
  }
  out.push(span);
  return out.sort((a, b) => a[0] - b[0]);
}
function postExtras(m, prev, threadRead) {
  const out = {};
  const r = m.replies ?? prev?.replies;
  if (r) {
    const same = prev?.replies && prev.replies.copyId === r.copyId && prev.replies.chatId === r.chatId;
    const read = Math.max(r.readMaxId ?? 0, same ? prev.replies.readMaxId ?? 0 : 0, threadRead?.(r.chatId, r.copyId) ?? 0);
    out.replies = { ...r, ...read ? { readMaxId: read } : {} };
  }
  const views = Math.max(m.views ?? 0, prev?.views ?? 0);
  if (m.views != null || prev?.views != null)
    out.views = views;
  if (m.reactionCounts) {
    out.reactionCounts = m.reactionCounts;
    if (m.myReaction)
      out.myReaction = m.myReaction;
  } else if (prev?.reactionCounts) {
    out.reactionCounts = prev.reactionCounts;
    if (prev.myReaction)
      out.myReaction = prev.myReaction;
  }
  return out;
}

class Store {
  db;
  userId;
  sessionsRev = 0;
  gifsRev = 0;
  stickersRev = 0;
  chats = new Map;
  outbox = new Map;
  pendingReads = new Map;
  lastSeq = 0;
  chatSeq = new Map;
  dirtyChatSeq = new Set;
  since = 0;
  seqHints = new Map;
  previews = new Set;
  hydrated = false;
  epoch = null;
  dialogsAt = 0;
  dialogsId = 0;
  dialogsDone = false;
  dialogsTotal = 0;
  touched = new Set;
  profile;
  get users() {
    return this.profile.users;
  }
  contacts;
  settings;
  blocks;
  members;
  profileLists;
  wantUser = () => {};
  refreshUser = () => {};
  contactOf = (id) => this.contacts.table.get(id);
  messages = new Map;
  loaded = new Set;
  dirtyChats = new Set;
  dirtyMessages = new Map;
  dirtyOutbox = new Set;
  rowPatches = new Map;
  staleTerms = new Map;
  dirtyReads = new Set;
  dirtyMeta = false;
  seqAtFlush = 0;
  onFlush = null;
  constructor(db, userId) {
    this.db = db;
    this.userId = userId;
  }
  async positions() {
    const rows = await getAll(this.db, "meta");
    const out = {};
    for (const r of rows)
      if (r.k.startsWith("pos:"))
        out[r.k.slice(4)] = r.v;
    return out;
  }
  async setPosition(key, pos) {
    const os = this.db.transaction("meta", "readwrite").objectStore("meta");
    if (pos)
      await req(os.put({ k: "pos:" + key, v: pos }));
    else
      await req(os.delete("pos:" + key));
  }
  static async open(db, userId) {
    const s = new Store(db, userId);
    for (const c of await getAll(db, "chats")) {
      if (!c.ranges) {
        c.ranges = [];
        s.legacyRanges.add(c.id);
      }
      s.chats.set(c.id, c);
      for (const m of [c.last, c.snapLast])
        if (m?.expiresAt && m.id != null)
          s.expiring.set(c.id + ":" + m.id, { chatId: c.id, id: m.id, at: m.expiresAt });
    }
    const outbox = (await getAll(db, "outbox")).sort((a, b) => a.createdAt - b.createdAt);
    for (const o of outbox)
      s.outbox.set(o.clientId, o);
    for (const r of await getAll(db, "pendingReads"))
      s.pendingReads.set(r.chatId, r.upToId);
    for (const r of await getAll(db, "chatSeq"))
      s.chatSeq.set(r.chatId, r.seq);
    for (const r of await getAll(db, "scheduled"))
      s.scheduled.set(r.clientId, r);
    const meta = await getAll(db, "meta");
    s.lastSeq = s.seqAtFlush = meta.find((m) => m.k === "lastSeq")?.v ?? 0;
    s.since = Number(meta.find((m) => m.k === "since")?.v ?? 0);
    s.clockSkew = Number(meta.find((m) => m.k === "clockSkew")?.v ?? 0);
    s.expiredFiles = new Set(meta.find((m) => m.k === "expiredFiles")?.v ?? []);
    s.hydrated = !!meta.find((m) => m.k === "hydrated")?.v;
    s.epoch = meta.find((m) => m.k === "epoch")?.v ?? null;
    s.dialogsAt = meta.find((m) => m.k === "dialogsAt")?.v ?? 0;
    s.dialogsId = meta.find((m) => m.k === "dialogsId")?.v ?? 0;
    s.dialogsDone = !!meta.find((m) => m.k === "dialogsDone")?.v;
    s.dialogsTotal = Number(meta.find((m) => m.k === "dialogsTotal")?.v ?? 0);
    s.profile = await ProfileCache.load(db, userId, meta);
    s.contacts = await ContactsCache.load(db, meta);
    s.settings = SettingsCache.load(meta);
    s.blocks = await BlocksCache.load(db, meta);
    s.members = await MembersCache.load(db, s.chatSeq);
    s.profileLists = await ProfileLists.load(db, meta);
    s.savedDialogs = await SavedDialogsCache.load(await getAll(db, "savedDialogs"), meta);
    for (const chatId of new Set(outbox.map((o) => o.chatId)))
      await s.loadChatMessages(chatId);
    return s;
  }
  savedDialogs = new SavedDialogsCache;
  savedPeerOf(savedChatId, fwd) {
    const src = fwd ? this.chats.get(fwd.chatId) : null;
    return savedPeerRule(fwd, savedChatId, src ? { kind: src.kind, peerId: src.peerId } : null);
  }
  localOf(m) {
    const { reactions: _r, ...rest } = m;
    return { ...rest, key: m.clientId, status: "sent", sort: m.id, kind: m.kind ?? "text" };
  }
  static unnamed(c) {
    return c.kind === "direct" && c.peerId == null && !c.group && !c.saved;
  }
  unnamed() {
    return [...this.chats.values()].filter(Store.unnamed).map((c) => c.id);
  }
  isLoaded(chatId) {
    return this.loaded.has(chatId);
  }
  async loadChatMessages(chatId) {
    if (this.loaded.has(chatId))
      return;
    const rows = await getByChat(this.db, chatId);
    const map = this.map(chatId), saved = !!this.chats.get(chatId)?.saved;
    for (const m of rows) {
      delete m.tab;
      if (saved && !m.savedPeer && !m.service && !m.deleted) {
        m.savedPeer = this.savedPeerOf(chatId, m.fwdFrom);
        this.dirtyMessages.set(m.key, m);
      }
      if (!map.has(m.key))
        map.set(m.key, m);
    }
    for (const [rk, rp] of [...this.rowPatches]) {
      if (rp.chatId !== chatId)
        continue;
      this.rowPatches.delete(rk);
      const old = rows.find((r) => r.id === rp.id);
      if (!old || map.get(old.key) !== old)
        continue;
      if (rp.drop) {
        map.delete(old.key);
        this.deletedMessages.add(old.key);
        for (const t of termsOf(old))
          this.staleTerms.set(termKey(t, old.chatId, old.sort), [t, old.chatId, old.sort]);
        continue;
      }
      const next = { ...old, ...rp.patch };
      map.set(old.key, next);
      this.dirtyMessages.set(old.key, next);
      const now = new Set(termsOf(next));
      for (const t of termsOf(old))
        if (!now.has(t))
          this.staleTerms.set(`${t}\x00${old.chatId}\x00${old.sort}`, [t, old.chatId, old.sort]);
    }
    this.loaded.add(chatId);
    this.touch(chatId);
    const chat = this.chats.get(chatId);
    if (chat && this.legacyRanges.delete(chatId)) {
      const server = this.chatMessages(chatId).filter((m) => m.id != null);
      chat.ranges = server.length ? [[server[0].sort, server[server.length - 1].sort]] : [];
      const old = chat;
      if (old.historyComplete)
        chat.historyStart = true;
      delete old.historyComplete;
      this.markChat(chat);
    }
  }
  legacyRanges = new Set;
  chatMessages(chatId) {
    let arr = this.sorted.get(chatId);
    if (!arr) {
      const map = this.messages.get(chatId);
      arr = map ? [...map.values()].sort((a, b) => a.sort - b.sort) : [];
      this.sorted.set(chatId, arr);
    }
    return arr;
  }
  sorted = new Map;
  ids = new Map;
  quotes = new Map;
  quoteFor(chatId, id) {
    return this.quotes.get(chatId + ":" + id);
  }
  typing = new Map;
  emojiFx = new Map;
  setTyping(chatId, userId, on) {
    let set = this.typing.get(chatId);
    if (on) {
      if (!set) {
        set = new Set;
        this.typing.set(chatId, set);
      }
      if (set.has(userId))
        return;
      set.add(userId);
    } else {
      if (!set?.delete(userId))
        return;
      if (!set.size)
        this.typing.delete(chatId);
    }
    this.touch(chatId);
  }
  quoteWants = new Map;
  quoteAsked = new Set;
  wantQuotes(chatId, ids) {
    for (const id of ids) {
      const k = chatId + ":" + id;
      if (this.quoteAsked.has(k))
        continue;
      this.quoteAsked.add(k);
      let set = this.quoteWants.get(chatId);
      if (!set) {
        set = new Set;
        this.quoteWants.set(chatId, set);
      }
      set.add(id);
    }
  }
  addQuotes(chatId, list, asked = []) {
    for (const m of list)
      this.quotes.set(chatId + ":" + m.id, toQuote(m));
    const got = new Set(list.map((m) => m.id));
    for (const id of asked)
      if (!got.has(id) && !this.messageById(chatId, id))
        this.quotes.set(chatId + ":" + id, deletedQuote(id, 0));
    this.addLoose(chatId, list);
    this.touch(chatId);
  }
  messageById(chatId, id) {
    let idx = this.ids.get(chatId);
    if (!idx) {
      idx = new Map;
      for (const m of this.chatMessages(chatId))
        if (m.id != null)
          idx.set(m.id, m);
      this.ids.set(chatId, idx);
    }
    return idx.get(id);
  }
  get termsDirty() {
    return this.dirtyMessages.size > 0 || this.staleTerms.size > 0 || this.rowPatches.size > 0 || this.deletedMessages.size > 0 || this.clearPersistedMessages;
  }
  loadedMessage(chatId, key) {
    return this.messages.get(chatId)?.get(key) ?? (this.deletedMessages.has(key) ? { key, chatId, deleted: true } : undefined);
  }
  applyUpdate(u, seq) {
    switch (u.type) {
      case "newMessage": {
        this.setTyping(u.message.chatId, u.message.senderId, false);
        const own = this.isOwn(u.message);
        this.applyMessage(u.message, true, "journal");
        if (!own || u.message.reminder)
          this.notify(u.message, false);
        return;
      }
      case "scheduled":
        this.scheduledRev++;
        return this.applyScheduled(u.item);
      case "scheduledRemoved":
        this.scheduledRev++;
        return this.removeScheduled(u.chatId, u.clientId);
      case "mention":
        return this.applyMention(u.message, u.threadId);
      case "reaction":
        return this.applyReaction(u.chatId, u.id);
      case "reactionsRead":
        return this.dropReactions(u.chatId, u.ids);
      case "readOwn":
        return this.applyOwnRead(u.chatId, u.upToId);
      case "readBy":
        return this.applyPeerRead(u.chatId, u.upToId);
      case "draft":
        return this.applyRemoteDraft(u.chatId, u.text, u.at, u.entities);
      case "messageEdited":
        return this.patchMessage(u.chatId, u.id, { body: u.body, editedAt: u.editedAt, entities: u.entities ?? [] });
      case "messageMarkup":
        return this.patchMessage(u.chatId, u.id, { body: u.body, entities: u.entities ?? [], buttons: u.buttons });
      case "messageDeleted":
        return this.removeMessage(u.chatId, u.id);
      case "reactions":
        return this.patchMessage(u.chatId, u.id, { reactions: u.reactions });
      case "reactionCounts":
        return this.patchMessage(u.chatId, u.id, { reactionCounts: u.counts });
      case "replies":
        return this.applyReplies(u.chatId, u.id, { count: u.count, lastId: u.lastId, recent: u.recent });
      case "readThread":
        return this.applyThreadRead(u.chatId, u.threadId, u.upToId);
      case "mediaListened":
        return this.patchMessage(u.chatId, u.id, { listened: true });
      case "todoUpdated":
        return this.patchMessage(u.chatId, u.id, { todo: u.todo, ...u.editedAt ? { editedAt: u.editedAt } : {} });
      case "pollUpdated": {
        const p = this.messageById(u.chatId, u.id)?.poll;
        if (!p)
          return;
        return this.patchMessage(u.chatId, u.id, { poll: { ...p, voters: u.voters, counts: u.counts, closed: u.closed, ...u.correct != null ? { correct: u.correct } : {}, ...u.solution ? { solution: u.solution } : {} } });
      }
      case "pollVoted": {
        const p = this.messageById(u.chatId, u.id)?.poll;
        if (!p)
          return;
        const { my: _, ...rest } = p;
        return this.patchMessage(u.chatId, u.id, { poll: { ...rest, ...u.my.length ? { my: u.my } : {}, ...u.correct != null ? { correct: u.correct } : {}, ...u.solution ? { solution: u.solution } : {} } });
      }
      case "linkPreview":
        return this.patchMessage(u.chatId, u.id, { link: u.link });
      case "attachmentUpdated":
        return this.patchMessage(u.chatId, u.id, { attachment: { ...this.messageById(u.chatId, u.id)?.attachment ?? {}, ...u.attachment } });
      case "userUpdated":
        return applyUserUpdated(this, u.user, seq);
      case "contactsChanged":
        return applyContactsChanged(this, u, seq);
      case "settingsChanged":
        this.settings.apply(u.settings, seq);
        return;
      case "privacyChanged":
        this.settings.applyPrivacy(u.rules, seq);
        return;
      case "blocksChanged":
        return applyBlocksChanged(this, u, seq);
      case "sessionsChanged":
        this.sessionsRev++;
        return;
      case "myGifs":
        this.gifsRev++;
        return;
      case "myStickers":
        this.stickersRev++;
        return;
      case "pins": {
        const chat = this.chats.get(u.chatId);
        if (chat) {
          chat.pinned = u.ids;
          this.markChat(chat);
        }
        return;
      }
      case "chatNotify":
        return this.setMute(u.chatId, u.muteUntil);
      case "chatTheme":
        return this.setTheme(u.chatId, u.theme);
      case "groupCall": {
        const chat = this.chats.get(u.chatId);
        if (chat) {
          chat.groupCall = u.call;
          if (u.plan !== undefined)
            chat.groupCallPlan = u.plan;
          this.markChat(chat);
        }
        return;
      }
      case "chatAutoDelete":
        return this.setAutoDelete(u.chatId, u.sec);
      case "chatFlags":
        return this.setFlags(u.chatId, u);
      case "savedDialog":
        return applySavedEvent(this, u);
      case "groupUpdated": {
        const chat = this.chats.get(u.chatId);
        if (chat) {
          const ownerId = u.group.ownerId ?? (chat.kind === "channel" && chat.me?.admin ? chat.group?.ownerId ?? null : null);
          chat.group = { ...u.group, ownerId, requests: chat.group?.requests ?? 0 };
          this.markChat(chat);
        }
        return;
      }
      case "joinRequests": {
        const chat = this.chats.get(u.chatId);
        if (chat?.group) {
          chat.group = { ...chat.group, requests: u.requests };
          this.markChat(chat);
        }
        return;
      }
      case "membership": {
        const chat = this.chats.get(u.chatId);
        if (chat) {
          chat.me = u.me;
          if (this.previews.has(u.chatId))
            this.promote(chat);
          this.markChat(chat);
          return;
        }
        if (u.seq != null && !this.chatSeq.has(u.chatId)) {
          this.setChatSeq(u.chatId, u.seq);
          this.seqHints.set(u.chatId, "new");
        }
        return;
      }
      case "members":
        return applyMembersUpdate(this, u.chatId, u.upsert, u.remove, seq);
      case "chatRemoved":
        return this.removeChat(u.chatId);
    }
  }
  applyPreview(s, requested = false) {
    this.previews.add(s.id);
    this.applyChats([s]);
    const c = this.chats.get(s.id);
    if (c && !!c.requested !== requested) {
      c.requested = requested;
      this.markChat(c);
    }
  }
  dropPreview(chatId) {
    if (!this.previews.has(chatId))
      return;
    for (const k of this.messages.get(chatId)?.keys() ?? [])
      this.dirtyMessages.delete(k);
    for (const [k, t] of this.staleTerms)
      if (t[1] === chatId)
        this.staleTerms.delete(k);
    this.removeChat(chatId);
    this.dirtyChats.delete(chatId);
    this.dirtyChatSeq.delete(chatId);
    this.previews.delete(chatId);
  }
  promote(chat) {
    this.previews.delete(chat.id);
    delete chat.requested;
    chat.unread = 0;
    chat.lastReadId = Math.max(chat.lastReadId, chat.knownMaxId);
    for (const m of this.messages.get(chat.id)?.values() ?? [])
      this.dirtyMessages.set(m.key, m);
    this.loaded.add(chat.id);
    if (this.chatSeq.has(chat.id))
      this.dirtyChatSeq.add(chat.id);
    this.seqHints.set(chat.id, "new");
  }
  setFlags(chatId, f) {
    const chat = this.chats.get(chatId);
    if (!chat)
      return;
    const sameAt = f.archivedAtId == null || (chat.archivedAtId ?? 0) === f.archivedAtId;
    if ((chat.pinnedAt ?? null) === f.pinnedAt && !!chat.archived === f.archived && !!chat.unreadMark === f.unreadMark && sameAt)
      return;
    chat.pinnedAt = f.pinnedAt;
    chat.archived = f.archived;
    chat.unreadMark = f.unreadMark;
    if (f.archivedAtId != null)
      chat.archivedAtId = f.archivedAtId;
    this.markChat(chat);
  }
  setChatSeq(chatId, seq) {
    if (this.chatSeq.get(chatId) === seq)
      return;
    this.chatSeq.set(chatId, seq);
    this.dirtyChatSeq.add(chatId);
  }
  setSince(ms) {
    if (ms <= this.since)
      return;
    this.since = ms;
    this.dirtyMeta = true;
  }
  async resetChat(chatId) {
    const c = this.chats.get(chatId);
    if (!c)
      return;
    if (!this.loaded.has(chatId))
      await this.loadChatMessages(chatId);
    const map = this.messages.get(chatId);
    if (map) {
      for (const [k, m] of map)
        if (m.id != null) {
          map.delete(k);
          this.dirtyMessages.delete(k);
          this.deletedMessages.add(k);
          for (const t of termsOf(m))
            this.staleTerms.set(termKey(t, chatId, m.sort), [t, chatId, m.sort]);
          this.rowPatches.delete(`${chatId}:${m.id}`);
        }
    }
    this.loaded.delete(chatId);
    c.ranges = [];
    delete c.historyStart;
    delete c.snapLast;
    delete c.seed;
    delete c.mediaDone;
    delete c.savedViews;
    delete c.mediaCounts;
    delete c.mediaCountsAt;
    delete c.threads;
    this.resetGen++;
    this.markChat(c);
  }
  deletedMessages = new Set;
  setTheme(chatId, theme) {
    const chat = this.chats.get(chatId);
    if (!chat || (chat.theme ?? null) === theme)
      return;
    chat.theme = theme;
    this.markChat(chat);
  }
  setAutoDelete(chatId, sec) {
    const chat = this.chats.get(chatId);
    if (!chat || (chat.autoDeleteSec ?? null) === sec)
      return;
    chat.autoDeleteSec = sec;
    this.markChat(chat);
  }
  setMute(chatId, muteUntil) {
    const chat = this.chats.get(chatId);
    if (!chat || (chat.muteUntil ?? null) === muteUntil)
      return;
    chat.muteUntil = muteUntil;
    this.markChat(chat);
  }
  removeChat(id) {
    if (!this.chats.has(id))
      return;
    if (this.chats.get(id).saved)
      this.savedDialogs.reset();
    this.chats.delete(id);
    this.chatV.delete(id);
    this.messages.delete(id);
    this.loaded.delete(id);
    this.members.dropChat(id);
    for (const k of [...this.threadReads.keys()])
      if (k.startsWith(id + ":")) {
        this.threadReads.delete(k);
        this.pendingThreadReads.delete(k);
      }
    if (this.chatSeq.delete(id))
      this.dirtyChatSeq.add(id);
    this.seqHints.delete(id);
    for (const [k, p] of this.rowPatches)
      if (p.chatId === id)
        this.rowPatches.delete(k);
    for (const [k, o] of this.outbox)
      if (o.chatId === id) {
        this.outbox.delete(k);
        this.dirtyOutbox.add(k);
      }
    if (this.pendingReads.delete(id))
      this.dirtyReads.add(id);
    this.dirtyChats.add(id);
    this.touch(id);
  }
  applySnapshot(list, seq = 0) {
    const keep = new Set(list.map((c) => c.id));
    for (const c of this.outbox.values())
      keep.add(c.chatId);
    for (const id of this.previews)
      keep.add(id);
    for (const id of [...this.chats.keys()])
      if (!keep.has(id)) {
        this.chats.delete(id);
        this.chatV.delete(id);
        this.messages.delete(id);
        this.loaded.delete(id);
        this.members.dropChat(id);
        this.dirtyChats.add(id);
        this.touch(id);
      }
    this.applyChats(list, seq);
  }
  applyChats(list, seq = 0) {
    if (!this.hydrated) {
      this.hydrated = true;
      this.dirtyMeta = true;
    }
    for (const s of list) {
      if (s.kind !== "direct" && s.seq != null) {
        const local = this.chatSeq.get(s.id);
        if (local == null)
          this.setChatSeq(s.id, s.seq);
        else if (s.seq < local)
          continue;
        else if (s.seq > local)
          this.seqHints.set(s.id, "ahead");
      }
      const chat = this.ensureChat(s.id);
      chat.kind = s.kind;
      chat.peerId = s.peer?.id ?? null;
      if (s.peer)
        this.profile.applyPeer(s.peer, seq);
      if (s.peer?.system)
        chat.system = true;
      else
        delete chat.system;
      if (s.saved)
        chat.saved = true;
      else
        delete chat.saved;
      if (s.theme !== undefined)
        chat.theme = s.theme;
      if (s.groupCall !== undefined)
        chat.groupCall = s.groupCall;
      if (s.groupCallPlan !== undefined)
        chat.groupCallPlan = s.groupCallPlan;
      if (s.autoDeleteSec !== undefined)
        chat.autoDeleteSec = s.autoDeleteSec;
      if (s.draft && (!chat.draft || s.draft.at > chat.draft.at) && !this.pendingDrafts.has(s.id))
        chat.draft = s.draft;
      if (s.pinned)
        chat.pinned = s.pinned;
      if (s.muteUntil !== undefined)
        chat.muteUntil = s.muteUntil;
      if (s.archived !== undefined) {
        chat.pinnedAt = s.pinnedAt ?? null;
        chat.archived = s.archived;
        chat.unreadMark = !!s.unreadMark;
      }
      if (s.archivedAtId != null)
        chat.archivedAtId = s.archivedAtId;
      if (s.group) {
        chat.group = s.group;
        chat.me = s.me;
      }
      if (s.peerReadUpTo && s.peerReadUpTo > chat.peerReadUpTo)
        this.applyPeerRead(s.id, s.peerReadUpTo);
      chat.lastReadId = Math.max(chat.lastReadId, s.lastReadId);
      chat.unread = s.unread;
      if (s.unreadMentions !== undefined) {
        chat.mentions = s.unreadMentions;
        if (!s.unreadMentions) {
          delete chat.mentionIds;
          delete chat.mentionThreads;
        }
      }
      if (s.unreadReactions !== undefined) {
        chat.reactions = s.unreadReactions;
        if (!s.unreadReactions)
          delete chat.reactionIds;
      }
      if (s.last) {
        chat.knownMaxId = Math.max(chat.knownMaxId, s.last.id);
        this.applyMessage(s.last, false, "snapshot");
        if (chat.last?.id === s.last.id)
          chat.lastAt = s.last.createdAt;
      } else if (!chat.last && s.sortAt)
        chat.lastAt = s.sortAt;
      this.markChat(chat);
    }
  }
  applyHistory(chatId, list, hasMore, before, gen) {
    this.applyPage(chatId, list, hasMore, before, "older", gen);
  }
  applyNewerHistory(chatId, list, hasMore, after, gen) {
    this.applyPage(chatId, list, hasMore, after, "newer", gen);
  }
  resetGen = 0;
  applyPage(chatId, list, hasMore, at, dir, gen) {
    if (gen != null && gen !== this.resetGen)
      return;
    for (const m of list)
      this.applyMessage(m, false, "none");
    const chat = this.ensureChat(chatId);
    for (const m of list)
      chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    let lo = null, hi = null;
    for (const m of list) {
      if (lo == null || m.id < lo)
        lo = m.id;
      if (hi == null || m.id > hi)
        hi = m.id;
    }
    const verifyFrom = dir === "older" && at != null && at === chat.seed ? chat.ranges[chat.ranges.length - 1]?.[0] : undefined;
    chat.ranges = addPage(chat.ranges, lo, hi, at, dir, !hasMore);
    if (!hasMore && dir === "older")
      chat.historyStart = true;
    if (verifyFrom !== undefined) {
      if (hasMore && lo != null && lo > verifyFrom)
        chat.seed = lo;
      else
        delete chat.seed;
    }
    const snap = chat.snapLast?.sort;
    if (snap != null && chat.ranges.some((r) => r[0] <= snap && snap <= r[1]))
      delete chat.snapLast;
    this.markChat(chat);
  }
  extendLive(chat, sort, own = false) {
    const snap = chat.snapLast?.sort, last = chat.ranges[chat.ranges.length - 1];
    if (snap == null || sort <= snap || last && snap <= last[1]) {
      extendLive(chat, sort, own);
      return;
    }
    chat.ranges.push([snap, sort]);
    chat.seed = snap;
    delete chat.mediaDone;
    delete chat.savedViews;
    this.placeSnapLast(chat);
  }
  placeSnapLast(c) {
    const m = c.snapLast;
    delete c.snapLast;
    if (m && !m.deleted && !this.messages.get(c.id)?.has(m.key))
      this.putMessage(m);
  }
  pendingSnapshots() {
    const out = new Map;
    for (const c of this.chats.values())
      if (c.snapLast && c.kind === "direct")
        out.set(c.id, c.snapLast.sort);
    return out;
  }
  settleSnapshots(pending) {
    for (const [id, sort] of pending) {
      const c = this.chats.get(id);
      if (!c || c.snapLast?.sort !== sort)
        continue;
      const last = c.ranges[c.ranges.length - 1];
      if (!last || sort > last[1]) {
        c.ranges.push([sort, sort]);
        c.seed = sort;
        delete c.mediaDone;
        delete c.savedViews;
      }
      this.placeSnapLast(c);
      this.markChat(c);
    }
  }
  addLoose(chatId, list) {
    for (const m of list)
      if (m.chatId === chatId)
        this.applyMessage(m, false, "none");
  }
  applyMessage(m, countUnread, range) {
    const chat = this.isGuest(m.chatId) ? null : this.ensureChat(m.chatId);
    const mine = m.senderId === this.userId;
    const map = this.map(m.chatId);
    const prev = map.get(m.clientId);
    if (range !== "journal" && !m.deleted && this.quotes.get(m.chatId + ":" + m.id)?.deleted)
      return;
    const status = mine && (prev?.status === "read" || m.id <= (chat?.peerReadUpTo ?? 0)) ? "read" : "sent";
    const local = {
      key: m.clientId,
      clientId: m.clientId,
      id: m.id,
      chatId: m.chatId,
      senderId: m.senderId,
      body: m.body,
      replyToId: m.replyToId,
      ...m.replyQuote ? { replyQuote: m.replyQuote } : null,
      createdAt: m.createdAt,
      status,
      sort: m.id,
      editedAt: m.editedAt ?? null,
      deleted: !!m.deleted,
      reactions: m.reactions ?? prev?.reactions ?? [],
      kind: m.kind ?? "text",
      attachment: m.attachment ?? null,
      entities: m.entities ?? [],
      ...m.listened != null ? { listened: m.listened } : {},
      ...m.service ? { service: m.service } : null,
      ...m.todo ? { todo: m.todo } : null,
      ...m.poll ? { poll: m.poll } : null,
      ...m.contact ? { contact: m.contact } : null,
      ...m.geo ? { geo: m.geo } : null,
      ...m.dice ? { dice: m.dice } : null,
      ...m.groupId ? { groupId: m.groupId } : null,
      ...m.fwdFrom ? { fwdFrom: m.fwdFrom } : null,
      ...m.savedPeer ? { savedPeer: m.savedPeer } : prev?.savedPeer && !m.deleted ? { savedPeer: prev.savedPeer } : null,
      ...m.blocks ? { blocks: m.blocks } : null,
      ...m.buttons ? { buttons: m.buttons } : null,
      ...m.sticker ? { sticker: m.sticker } : null,
      ...m.post ? { post: true } : null,
      ...m.postAuthor ? { postAuthor: m.postAuthor } : null,
      ...m.silent ? { silent: true } : null,
      ...m.reminder ? { reminder: true } : null,
      ...m.expiresAt ? { expiresAt: m.expiresAt } : null,
      ...m.threadId != null ? { threadId: m.threadId } : null,
      ...m.origin ? { origin: m.origin } : null,
      ...postExtras(m, prev, (c, t) => this.threadReads.get(c + ":" + t)),
      ...m.link ? { link: m.link.pending && prev?.link && !prev.link.pending && prev.link.url === m.link.url ? prev.link : m.link } : null
    };
    if (local.deleted)
      Object.assign(local, DELETED);
    if (local.expiresAt)
      this.noteExpiry(m.chatId, m.id, local.expiresAt);
    if (m.origin && !local.deleted) {
      let copyId = m.id;
      if (m.groupId) {
        for (const x of this.chatMessages(m.chatId))
          if (x.groupId === m.groupId && x.origin && x.id != null && x.id < copyId)
            copyId = x.id;
      }
      this.copyByPost.set(m.origin.chatId + ":" + m.origin.id, { chatId: m.chatId, copyId });
      const p = this.messageById(m.origin.chatId, m.origin.id);
      if (p && !p.replies && !p.deleted && p.id != null)
        this.patchMessage(p.chatId, p.id, { replies: this.baseReplies(m.chatId, copyId) });
    } else if (m.post && !local.replies && !local.deleted) {
      const c = this.copyByPost.get(m.chatId + ":" + m.id);
      if (c)
        local.replies = this.baseReplies(c.chatId, c.copyId);
    }
    if (!chat) {
      if (range === "journal" && m.threadId != null)
        this.extendThread(m.chatId, m.threadId, m.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(local))
        this.putMessage(local);
      return;
    }
    unreadOnArrival(this, chat, m, countUnread);
    chat.knownMaxId = Math.max(chat.knownMaxId, m.id);
    if (range === "journal") {
      this.extendLive(chat, m.id);
      if (m.threadId != null)
        this.extendThread(m.chatId, m.threadId, m.id);
    } else if (range === "snapshot" && !snapshotLive(chat, local) && !prev) {
      onMessage(this, chat, local, "added");
      return;
    }
    if (!prev || JSON.stringify(prev) !== JSON.stringify(local))
      this.putMessage(local);
    this.markChat(chat);
  }
  applyViews(chatId, views) {
    for (const [id, n] of views) {
      const m = this.messageById(chatId, id);
      if (m && n > (m.views ?? 0))
        this.patchMessage(chatId, id, { views: n });
    }
  }
  applyOwnRead(chatId, upToId) {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.lastReadId)
      return;
    chat.unread = unreadAfterRead(this, chat, chat.lastReadId, upToId);
    chat.lastReadId = upToId;
    this.dropMentions(chatId, (id, thread) => thread == null && id <= upToId, upToId >= chat.knownMaxId);
    this.markChat(chat);
  }
  isOwn(m) {
    return m.senderId === this.userId || this.outbox.has(m.clientId) || this.messages.get(m.chatId)?.get(m.clientId)?.senderId === this.userId;
  }
  applyMention(m, threadId) {
    const chat = this.chats.get(m.chatId);
    if (!chat)
      return;
    const read = threadId != null ? this.threadReads.get(m.chatId + ":" + threadId) ?? 0 : chat.lastReadId;
    const ids = chat.mentionIds ?? [];
    if (m.id <= read || ids.includes(m.id))
      return;
    ids.push(m.id);
    ids.sort((a, b) => a - b);
    chat.mentionIds = ids;
    if (threadId != null)
      (chat.mentionThreads ??= {})[m.id] = threadId;
    chat.mentions = (chat.mentions ?? 0) + 1;
    this.markChat(chat);
    this.notify(m, true, threadId);
  }
  dropMentions(chatId, gone, all = false) {
    const chat = this.chats.get(chatId);
    if (!chat || !chat.mentions)
      return;
    const ids = chat.mentionIds ?? [], threads = chat.mentionThreads ?? {};
    const keep = ids.filter((id) => !gone(id, threads[id]));
    const unknown = all ? 0 : Math.max(0, chat.mentions - ids.length);
    if (keep.length === ids.length && unknown === chat.mentions - ids.length)
      return;
    for (const id of ids)
      if (!keep.includes(id))
        delete threads[id];
    chat.mentionIds = keep;
    chat.mentions = keep.length + unknown;
    if (!keep.length) {
      delete chat.mentionIds;
      delete chat.mentionThreads;
    }
    this.markChat(chat);
  }
  applyReaction(chatId, id) {
    const chat = this.chats.get(chatId);
    if (!chat)
      return;
    const ids = chat.reactionIds ?? [];
    if (ids.includes(id))
      return;
    const counted = (chat.reactions ?? 0) > ids.length;
    ids.push(id);
    ids.sort((a, b) => a - b);
    chat.reactionIds = ids;
    chat.reactions = counted ? Math.max(chat.reactions ?? 0, ids.length) : ids.length;
    this.markChat(chat);
  }
  dropReactions(chatId, ids, knownOnly = false) {
    const chat = this.chats.get(chatId);
    if (!chat || !chat.reactions)
      return;
    if (!ids) {
      chat.reactions = 0;
      delete chat.reactionIds;
      this.markChat(chat);
      return;
    }
    const known = chat.reactionIds ?? [], keep = known.filter((x) => !ids.includes(x));
    const unknownGone = knownOnly ? 0 : ids.filter((x) => !known.includes(x)).length;
    if (keep.length === known.length && !unknownGone)
      return;
    const unknown = Math.max(0, chat.reactions - known.length - unknownGone);
    chat.reactionIds = keep;
    chat.reactions = keep.length + unknown;
    if (!keep.length)
      delete chat.reactionIds;
    this.markChat(chat);
  }
  nextReaction(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat?.reactionIds?.length || chat.reactionIds.length < (chat.reactions ?? 0))
      return null;
    return chat.reactionIds[0];
  }
  setReactionIds(chatId, ids, count) {
    const chat = this.chats.get(chatId);
    if (!chat)
      return;
    chat.reactionIds = ids.length ? [...ids].sort((a, b) => a - b) : undefined;
    chat.reactions = Math.max(count, ids.length);
    if (!chat.reactions)
      delete chat.reactionIds;
    this.markChat(chat);
  }
  nextMention(chatId) {
    const chat = this.chats.get(chatId);
    const id = chat?.mentionIds?.[0];
    if (id == null)
      return null;
    const threadId = chat.mentionThreads?.[id];
    return threadId != null ? { id, threadId } : { id };
  }
  notifications = [];
  notifiedIds = new Set;
  notify(m, mention, threadId) {
    if (this.previews.has(m.chatId))
      return;
    if (m.silent)
      return;
    const k = m.chatId + ":" + m.id;
    if (this.notifiedIds.has(k))
      return;
    this.notifiedIds.add(k);
    if (m.groupId && !mention) {
      const ak = m.chatId + ":album:" + m.groupId;
      if (this.notifiedIds.has(ak))
        return;
      this.notifiedIds.add(ak);
    }
    if (this.notifiedIds.size > 2000)
      this.notifiedIds.delete(this.notifiedIds.values().next().value);
    const thread = threadId ?? m.threadId;
    this.notifications.push({
      key: "n" + k,
      chatId: m.chatId,
      id: m.id,
      mention,
      ...thread != null ? { threadId: thread } : {},
      senderId: m.senderId,
      body: m.body,
      kind: m.kind ?? "text",
      createdAt: m.createdAt,
      attachmentName: m.attachment?.name ?? null,
      ...m.entities?.length ? { entities: m.entities } : {},
      ...m.service ? { service: m.service } : {},
      ...m.post ? { post: true } : {},
      ...m.reminder ? { reminder: true } : {}
    });
    if (this.notifications.length > NOTIFY_KEEP)
      this.notifications.splice(0, this.notifications.length - NOTIFY_KEEP);
    this.touch(m.chatId);
  }
  applyPeerRead(chatId, upToId) {
    const chat = this.ensureChat(chatId);
    if (upToId <= chat.peerReadUpTo)
      return;
    chat.peerReadUpTo = upToId;
    for (const m of this.messages.get(chatId)?.values() ?? []) {
      if (m.senderId === this.userId && m.id != null && m.id <= upToId && m.status !== "read")
        this.putMessage({ ...m, status: "read" });
    }
    if (chat.last && chat.last.senderId === this.userId && chat.last.id != null && chat.last.id <= upToId && chat.last.status !== "read")
      onMessage(this, chat, { ...chat.last, status: "read" }, "edited", chat.last);
    this.markChat(chat);
  }
  localRead(chatId, upToId) {
    const chat = this.chats.get(chatId);
    if (!chat || upToId <= chat.lastReadId)
      return false;
    this.applyOwnRead(chatId, upToId);
    this.pendingReads.set(chatId, Math.max(this.pendingReads.get(chatId) ?? 0, upToId));
    this.dirtyReads.add(chatId);
    return true;
  }
  readSent(chatId, upToId) {
    if ((this.pendingReads.get(chatId) ?? 0) <= upToId) {
      this.pendingReads.delete(chatId);
      this.dirtyReads.add(chatId);
    }
  }
  addPending(o) {
    this.outbox.set(o.clientId, o);
    this.dirtyOutbox.add(o.clientId);
    if (o.scheduleAt != null) {
      this.touchScheduled(o.chatId);
      return;
    }
    if (o.threadId != null && !this.chats.has(o.chatId) && !this.guests.has(o.chatId))
      return;
    if (!this.isGuest(o.chatId))
      this.ensureChat(o.chatId);
    this.loaded.add(o.chatId);
    this.putMessage({
      key: o.clientId,
      clientId: o.clientId,
      id: null,
      chatId: o.chatId,
      senderId: this.userId,
      body: o.body,
      entities: o.entities ?? [],
      replyToId: o.replyToId,
      ...o.replyQuote ? { replyQuote: o.replyQuote } : {},
      createdAt: new Date(o.createdAt).toISOString(),
      status: o.failed ? "failed" : "pending",
      sort: PENDING_BASE + o.createdAt,
      kind: o.sticker ? "sticker" : o.todo ? "todo" : o.poll ? "poll" : o.special?.contact ? "contact" : o.special?.geo ? "geo" : o.special?.dice ? "dice" : o.attachment ? o.attachment.kind : "text",
      ...o.sticker ? { sticker: o.sticker } : {},
      attachment: o.attachment ?? null,
      ...o.todo ? { todo: o.todo } : {},
      ...o.poll ? { poll: pendingPoll(o.poll) } : {},
      ...o.special?.contact ? { contact: { userId: o.special.contact.userId, name: o.special.contact.name } } : {},
      ...o.special?.geo ? { geo: o.special.geo } : {},
      ...o.special?.dice ? { dice: { emoji: o.special.dice.emoji, value: 0 } } : {},
      progress: o.attachment && !o.attachment.id ? 0 : undefined,
      ...o.failed && o.error ? { error: o.error } : {},
      ...o.groupId ? { groupId: o.groupId } : {},
      ...o.fwdFrom ? { fwdFrom: o.fwdFrom } : {},
      ...this.chats.get(o.chatId)?.saved ? { savedPeer: this.savedPeerOf(o.chatId, o.fwdFrom ?? null) } : {},
      ...o.link ? { link: o.link } : {},
      ...o.blocks ? { blocks: o.blocks } : {},
      ...o.threadId != null ? { threadId: o.threadId } : {}
    });
  }
  ack(clientId, id, createdAt) {
    const o = this.outbox.get(clientId);
    if (o) {
      this.outbox.delete(o.clientId);
      this.dirtyOutbox.add(o.clientId);
    }
    const chatId = o?.chatId ?? this.findChatOf(clientId);
    if (chatId == null)
      return;
    const m = this.messages.get(chatId)?.get(clientId);
    if (this.isGuest(chatId) || !this.chats.has(chatId) && !m) {
      if (!m)
        return;
      this.putMessage({ ...m, id, createdAt, sort: id, status: m.status === "read" ? "read" : "sent" });
      if (m.threadId != null) {
        this.extendThread(chatId, m.threadId, id, true);
        this.applyThreadRead(chatId, m.threadId, id);
      }
      return;
    }
    const chat = this.ensureChat(chatId);
    if (m)
      this.putMessage({ ...m, id, createdAt, sort: id, status: m.status === "read" || id <= chat.peerReadUpTo ? "read" : "sent" });
    chat.knownMaxId = Math.max(chat.knownMaxId, id);
    this.extendLive(chat, id, true);
    if (m?.threadId != null) {
      this.extendThread(chatId, m.threadId, id, true);
      this.applyThreadRead(chatId, m.threadId, id);
    }
    this.markChat(chat);
  }
  scheduled = new Map;
  dirtyScheduled = new Set;
  scheduledProgress = new Map;
  scheduledCounts = null;
  scheduledRev = 0;
  scheduledBusy = () => false;
  touchScheduled(chatId) {
    this.scheduledCounts = null;
    const c = this.chats.get(chatId);
    if (c)
      this.markChat(c);
    else
      this.touch(chatId);
  }
  scheduledCount(chatId) {
    if (!this.scheduledCounts) {
      const n = this.scheduledCounts = new Map;
      for (const s of this.scheduled.values())
        if (!this.outbox.has(s.clientId))
          n.set(s.chatId, (n.get(s.chatId) ?? 0) + 1);
      for (const o of this.outbox.values())
        if (o.scheduleAt != null)
          n.set(o.chatId, (n.get(o.chatId) ?? 0) + 1);
    }
    return this.scheduledCounts.get(chatId) ?? 0;
  }
  applyScheduled(item, force = false) {
    if (!force && this.scheduledBusy(item.clientId))
      return;
    const cur = this.scheduled.get(item.clientId);
    if (cur && cur.rev > item.rev)
      return;
    this.scheduled.set(item.clientId, item);
    this.dirtyScheduled.add(item.clientId);
    this.touchScheduled(item.chatId);
  }
  removeScheduled(chatId, clientId) {
    if (!this.scheduled.delete(clientId))
      return;
    this.dirtyScheduled.add(clientId);
    this.touchScheduled(chatId);
  }
  replaceScheduled(items) {
    const next = new Map(items.filter((x) => !this.scheduledBusy(x.clientId)).map((x) => [x.clientId, x]));
    for (const [k, v] of this.scheduled)
      if (this.scheduledBusy(k))
        next.set(k, v);
    for (const [k, v] of this.scheduled)
      if (!next.has(k)) {
        this.dirtyScheduled.add(k);
        this.touchScheduled(v.chatId);
      }
    for (const [k, v] of next) {
      if (JSON.stringify(this.scheduled.get(k)) === JSON.stringify(v))
        continue;
      this.dirtyScheduled.add(k);
      this.touchScheduled(v.chatId);
    }
    this.scheduled = next;
    this.scheduledCounts = null;
  }
  patchScheduled(clientId, p) {
    const cur = this.scheduled.get(clientId);
    if (!cur)
      return;
    const { failed: _f, ...rest } = cur;
    this.scheduled.set(clientId, { ...rest, ...p });
    this.dirtyScheduled.add(clientId);
    this.touchScheduled(cur.chatId);
  }
  patchOutboxScheduled(clientId, p) {
    const o = this.outbox.get(clientId);
    if (!o)
      return;
    if (p.sendAt != null)
      o.scheduleAt = p.sendAt;
    if (p.body != null)
      o.body = p.body;
    if (p.entities != null)
      o.entities = p.entities;
    o.failed = false;
    delete o.error;
    this.dirtyOutbox.add(clientId);
    this.touchScheduled(o.chatId);
  }
  ackScheduled(clientId, item) {
    const o = this.outbox.get(clientId);
    if (o) {
      this.outbox.delete(clientId);
      this.dirtyOutbox.add(clientId);
      this.touchScheduled(o.chatId);
    }
    this.scheduledProgress.delete(clientId);
    if (item)
      this.applyScheduled(item, true);
  }
  promoteScheduled(clientId, createdAt) {
    const o = this.outbox.get(clientId);
    if (o?.scheduleAt == null)
      return;
    delete o.scheduleAt;
    o.createdAt = createdAt;
    this.scheduledCounts = null;
    this.addPending(o);
    this.touchScheduled(o.chatId);
  }
  scheduledMessages(chatId) {
    const rows = [];
    const base = (clientId, at) => ({ key: clientId, clientId, id: null, chatId, senderId: this.userId, replyToId: null, createdAt: new Date(at).toISOString(), sort: at, scheduled: true });
    for (const o of this.outbox.values()) {
      if (o.chatId !== chatId || o.scheduleAt == null)
        continue;
      const p = this.scheduledProgress.get(o.clientId);
      rows.push({ at: o.scheduleAt, created: o.createdAt, m: {
        ...base(o.clientId, o.scheduleAt),
        body: o.body,
        entities: o.entities ?? [],
        replyToId: o.replyToId,
        ...o.replyQuote ? { replyQuote: o.replyQuote } : {},
        status: o.failed ? "failed" : "pending",
        kind: o.sticker ? "sticker" : o.attachment ? o.attachment.kind : "text",
        ...o.sticker ? { sticker: o.sticker } : {},
        ...o.attachment ? { attachment: o.attachment } : {},
        ...o.groupId ? { groupId: o.groupId } : {},
        ...o.silent ? { silent: true } : {},
        ...o.failed && o.error ? { error: o.error } : {},
        ...p != null && p < 1 ? { progress: p } : {}
      } });
    }
    for (const s of this.scheduled.values()) {
      if (s.chatId !== chatId || this.outbox.has(s.clientId))
        continue;
      rows.push({ at: s.sendAt, created: Date.parse(s.createdAt), m: {
        ...base(s.clientId, s.sendAt),
        body: s.body,
        entities: s.entities ?? [],
        replyToId: s.replyToId,
        ...s.replyQuote ? { replyQuote: s.replyQuote } : {},
        status: s.failed ? "failed" : "sent",
        kind: s.kind,
        ...s.sticker ? { sticker: s.sticker } : {},
        ...s.attachment ? { attachment: s.attachment } : {},
        ...s.groupId ? { groupId: s.groupId } : {},
        ...s.silent ? { silent: true } : {},
        ...s.failed ? { error: s.failed } : {}
      } });
    }
    rows.sort((a, b) => a.at - b.at || a.created - b.created);
    return rows.map((r, i) => ({ ...r.m, sort: r.at + i / 1000 }));
  }
  threadReads = new Map;
  pendingThreadReads = new Map;
  wantPost = () => {};
  copyByPost = new Map;
  baseReplies(chatId, copyId) {
    const read = this.threadReads.get(chatId + ":" + copyId);
    return { copyId, chatId, count: 0, lastId: null, recent: [], ...read ? { readMaxId: read } : {} };
  }
  extendThread(chatId, threadId, sort, own = false) {
    const chat = this.chats.get(chatId);
    const t = chat ? chat.threads?.[threadId] : this.guests.get(chatId)?.threads[threadId];
    if (!t)
      return;
    extendLive(t, sort, own);
    if (chat)
      this.markChat(chat);
    else
      this.touch(chatId);
  }
  threadRanges(chatId, threadId) {
    const chat = this.chats.get(chatId);
    return chat ? chat.threads?.[threadId] : this.guests.get(chatId)?.threads[threadId];
  }
  guests = new Map;
  guestWatch(chatId, threadId, on) {
    const g = this.guests.get(chatId);
    if (g) {
      if (on)
        g.open.add(threadId);
      else
        g.open.delete(threadId);
    }
  }
  isGuest(chatId) {
    return !this.chats.has(chatId) && this.guests.has(chatId);
  }
  guestInfo(chatId) {
    return this.isGuest(chatId) ? this.guests.get(chatId).info : null;
  }
  applyGuestPush(chatId, items) {
    if (!this.isGuest(chatId))
      return;
    for (const u of items) {
      if (u.type === "newMessage") {
        if (u.message.chatId === chatId)
          this.applyMessage(u.message, false, "journal");
      } else if (u.type === "groupUpdated") {
        const g = this.guests.get(chatId), n = u.group;
        g.info = { ...g.info, title: n.title, username: n.username, joinToSend: !!n.joinToSend, joinApproval: n.joinApproval, slowMode: n.slowMode };
        this.touch(chatId);
      } else if (GUEST_UPDATES.has(u.type) && u.chatId === chatId)
        this.applyUpdate(u);
    }
  }
  applyThreadPage(chatId, threadId, header, list, hasMore, at, dir, gen, guest) {
    if (gen != null && gen !== this.resetGen)
      return;
    if (guest && !this.chats.has(chatId)) {
      const g = this.guests.get(chatId);
      this.guests.set(chatId, { info: guest, threads: g?.threads ?? {}, open: g?.open ?? new Set });
    } else if (!guest && this.guests.delete(chatId))
      this.touch(chatId);
    if (header)
      this.applyMessage(header, false, "none");
    for (const m of list)
      this.applyMessage(m, false, "none");
    const chat = this.isGuest(chatId) ? null : this.ensureChat(chatId);
    const threads = chat ? chat.threads ??= {} : this.guests.get(chatId).threads;
    const t = threads[threadId] ?? (threads[threadId] = { ranges: [] });
    let lo = null, hi = null;
    for (const m of list) {
      if (lo == null || m.id < lo)
        lo = m.id;
      if (hi == null || m.id > hi)
        hi = m.id;
    }
    t.ranges = addPage(t.ranges, lo, hi, at, dir, !hasMore);
    if (!hasMore && dir === "older")
      t.historyStart = true;
    if (chat)
      this.markChat(chat);
    else
      this.touch(chatId);
  }
  applyReplies(chatId, id, r) {
    const m = this.messageById(chatId, id);
    if (m?.replies) {
      this.patchMessage(chatId, id, { replies: { ...m.replies, ...r } });
      return;
    }
    if (m)
      this.wantPost(chatId, id);
  }
  applyThreadRead(chatId, threadId, upToId) {
    const k = chatId + ":" + threadId;
    if ((this.threadReads.get(k) ?? 0) >= upToId)
      return;
    this.threadReads.set(k, upToId);
    this.dropMentions(chatId, (id, t) => t === threadId && id <= upToId);
    const copy = this.messageById(chatId, threadId);
    const channelId = copy?.origin?.chatId ?? this.chats.get(chatId)?.group?.linkedChatId ?? this.guests.get(chatId)?.info.channelId ?? null;
    if (channelId == null)
      return;
    const post = copy?.origin ? this.messageById(channelId, copy.origin.id) : this.chatMessages(channelId).find((x) => x.replies?.copyId === threadId && x.replies.chatId === chatId);
    if (post?.replies && post.id != null && (post.replies.readMaxId ?? 0) < upToId)
      this.patchMessage(channelId, post.id, { replies: { ...post.replies, readMaxId: upToId } });
  }
  localThreadRead(chatId, threadId, upToId) {
    const k = chatId + ":" + threadId;
    if ((this.threadReads.get(k) ?? 0) >= upToId)
      return false;
    this.applyThreadRead(chatId, threadId, upToId);
    this.pendingThreadReads.set(k, Math.max(this.pendingThreadReads.get(k) ?? 0, upToId));
    return true;
  }
  dropQuote(clientId) {
    const o = this.outbox.get(clientId);
    if (!o?.replyQuote)
      return false;
    delete o.replyQuote;
    this.dirtyOutbox.add(clientId);
    if (o.scheduleAt != null)
      this.touchScheduled(o.chatId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) {
      const { replyQuote: _q, ...rest } = m;
      this.putMessage(rest);
    }
    return true;
  }
  fail(clientId, error) {
    const o = this.outbox.get(clientId);
    if (!o)
      return;
    o.failed = true;
    if (error)
      o.error = error;
    else
      delete o.error;
    this.dirtyOutbox.add(clientId);
    if (o.scheduleAt != null)
      this.touchScheduled(o.chatId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m)
      this.putMessage({ ...m, status: "failed", ...error ? { error } : {} });
  }
  unfail(clientId) {
    const o = this.outbox.get(clientId);
    if (!o || !o.failed)
      return false;
    o.failed = false;
    delete o.error;
    this.dirtyOutbox.add(clientId);
    if (o.scheduleAt != null)
      this.touchScheduled(o.chatId);
    const m = this.messages.get(o.chatId)?.get(clientId);
    if (m) {
      const { error: _e, ...rest } = m;
      this.putMessage({ ...rest, status: "pending" });
    }
    return true;
  }
  discardFailed() {
    return this.discard([...this.outbox.values()].filter((o) => o.failed).map((o) => o.clientId));
  }
  discard(clientIds) {
    const ids = [];
    for (const clientId of clientIds) {
      const o = this.outbox.get(clientId);
      if (!o)
        continue;
      ids.push(o.clientId);
      this.outbox.delete(o.clientId);
      this.dirtyOutbox.add(o.clientId);
      this.dirtyMessages.delete(o.clientId);
      if (o.scheduleAt != null)
        this.touchScheduled(o.chatId);
      this.messages.get(o.chatId)?.delete(o.clientId);
      this.touch(o.chatId);
      const chat = this.chats.get(o.chatId);
      if (chat?.last?.key === o.clientId)
        recomputeLast(this, chat);
      if (chat)
        this.markChat(chat);
    }
    return ids;
  }
  setUploaded(clientId, id) {
    const o = this.outbox.get(clientId);
    if (!o?.attachment)
      return;
    o.attachment = { ...o.attachment, id };
    delete o.upload;
    this.dirtyOutbox.add(clientId);
    this.setProgress(clientId, 1);
  }
  setUploadState(clientId, up) {
    const o = this.outbox.get(clientId);
    if (!o)
      return;
    if (up)
      o.upload = up;
    else
      delete o.upload;
    this.dirtyOutbox.add(clientId);
  }
  progressOf(clientId) {
    const chatId = this.outbox.get(clientId)?.chatId;
    if (this.scheduledProgress.has(clientId))
      return this.scheduledProgress.get(clientId);
    return (chatId != null ? this.messages.get(chatId)?.get(clientId)?.progress : undefined) ?? 0;
  }
  setProgress(clientId, p) {
    const o = this.outbox.get(clientId);
    if (o?.scheduleAt != null) {
      this.scheduledProgress.set(clientId, p);
      this.touch(o.chatId);
      return;
    }
    const chatId = o?.chatId;
    const m = chatId != null ? this.messages.get(chatId)?.get(clientId) : undefined;
    if (m)
      this.putMessage({ ...m, progress: p });
  }
  removeMessage(chatId, id) {
    this.expiring.delete(chatId + ":" + id);
    this.dropMentions(chatId, (x) => x === id);
    this.dropReactions(chatId, [id], true);
    const k = chatId + ":" + id, m = this.messageById(chatId, id), q = this.quotes.get(k);
    if (!q?.deleted) {
      this.quotes.set(k, deletedQuote(id, m?.senderId ?? q?.senderId ?? 0));
      this.touch(chatId);
    }
    const here = this.messages.get(chatId);
    if (here) {
      for (const r of here.values())
        if (r.replyToId === id && r.replyQuote) {
          const { replyQuote: _q, ...rest } = r;
          this.putMessage(rest);
        }
    }
    const n = this.notifications.length;
    this.notifications = this.notifications.filter((x) => !(x.chatId === chatId && x.id === id));
    if (this.notifications.length !== n)
      this.touch(chatId);
    const chat = this.chats.get(chatId);
    if (!chat) {
      if (m && !m.deleted && this.isGuest(chatId)) {
        if (m.origin)
          this.putMessage({ ...m, ...DELETED });
        else {
          this.messages.get(chatId).delete(m.key);
          this.touch(chatId);
        }
      }
      return;
    }
    if (chat.snapLast?.id === id) {
      extendLive(chat, chat.snapLast.sort);
      delete chat.snapLast;
      this.markChat(chat);
    }
    if (!m) {
      this.rowPatches.set(k, { chatId, id, patch: { ...DELETED }, drop: true });
      const last = chat.last;
      if (last?.id === id) {
        if (!last.deleted && last.senderId !== this.userId && id > chat.lastReadId && chat.unread > 0)
          chat.unread--;
        onMessage(this, chat, { ...last, ...DELETED }, "deleted", last);
        return;
      }
      if (id > chat.lastReadId && chat.unread > 0)
        this.wantRow(chatId);
      if (chat.mediaCounts && id <= (chat.mediaCountsAt ?? 0)) {
        delete chat.mediaCounts;
        delete chat.mediaCountsAt;
        this.markChat(chat);
      }
      if (chat.saved && chat.savedViews) {
        delete chat.savedViews;
        this.markChat(chat);
        this.savedDialogs.want = true;
      }
      return;
    }
    if (m.deleted)
      return;
    if (m.senderId !== this.userId && id > chat.lastReadId && chat.unread > 0)
      chat.unread--;
    if (m.origin) {
      this.putMessage({ ...m, ...DELETED });
      return;
    }
    const map = this.messages.get(chatId);
    map.delete(m.key);
    this.dirtyMessages.delete(m.key);
    this.deletedMessages.add(m.key);
    for (const t of termsOf(m))
      this.staleTerms.set(termKey(t, chatId, m.sort), [t, chatId, m.sort]);
    this.rowPatches.delete(k);
    this.touch(chatId);
    onMessage(this, chat, { ...m, ...DELETED }, "deleted", m);
  }
  clockSkew = 0;
  serverNow() {
    return Date.now() + this.clockSkew;
  }
  setClockSkew(ms) {
    if (Math.abs(ms - this.clockSkew) < 500)
      return;
    this.clockSkew = ms;
    this.dirtyMeta = true;
  }
  expiring = new Map;
  onExpiry = () => {};
  noteExpiry(chatId, id, at) {
    this.expiring.set(chatId + ":" + id, { chatId, id, at });
    this.onExpiry(at);
  }
  expiredFiles = new Set;
  ackExpiredFiles(ids) {
    for (const id of ids)
      this.expiredFiles.delete(id);
    this.dirtyMeta = true;
  }
  async nextExpiry() {
    let at = await firstExpiry(this.db);
    for (const e of this.expiring.values())
      if (at == null || e.at < at)
        at = e.at;
    return at;
  }
  async sweepExpired(now = this.serverNow()) {
    const due = new Map;
    for (const [k, e] of this.expiring)
      if (e.at <= now)
        due.set(k, e);
    for (const r of await getExpiredRows(this.db, now))
      if (r.id != null)
        due.set(r.chatId + ":" + r.id, { chatId: r.chatId, id: r.id, key: r.key });
    for (const chatId of new Set([...due.values()].map((d) => d.chatId))) {
      if (this.chats.has(chatId) && !this.previews.has(chatId) && !this.loaded.has(chatId))
        await this.loadChatMessages(chatId);
    }
    for (const [k, d] of due) {
      const chat = this.chats.get(d.chatId), m = this.messageById(d.chatId, d.id);
      const copy = chat?.last?.id === d.id ? chat.last : chat?.snapLast?.id === d.id ? chat.snapLast : null;
      const att = (m ?? copy)?.attachment;
      if (att?.id) {
        this.expiredFiles.add(att.id);
        this.dirtyMeta = true;
      }
      if (!chat && !this.isGuest(d.chatId)) {
        this.expiring.delete(k);
        if (d.key)
          this.deletedMessages.add(d.key);
        continue;
      }
      if (chat?.pinned?.includes(d.id)) {
        chat.pinned = chat.pinned.filter((x) => x !== d.id);
        this.markChat(chat);
      }
      this.removeMessage(d.chatId, d.id);
    }
    return due.size;
  }
  wantRow = () => {};
  patchMessage(chatId, id, patch) {
    const m = this.messageById(chatId, id);
    if (m) {
      this.putMessage({ ...m, ...patch });
      return;
    }
    if (this.isGuest(chatId))
      return;
    const rk = `${chatId}:${id}`, prevP = this.rowPatches.get(rk);
    this.rowPatches.set(rk, { ...prevP, chatId, id, patch: { ...prevP?.patch, ...patch } });
    const chat0 = this.chats.get(chatId);
    if (chat0?.snapLast?.id === id) {
      chat0.snapLast = { ...chat0.snapLast, ...patch };
      this.markChat(chat0);
    }
    if (chat0?.saved) {
      for (const r of this.savedDialogs.rows.values())
        if (r.last?.id === id) {
          this.savedDialogs.put({ ...r, last: { ...r.last, ...patch } });
          this.touch(chatId);
          break;
        }
    }
    const chat = this.chats.get(chatId);
    if (chat?.last && chat.last.id === id) {
      onMessage(this, chat, { ...chat.last, ...patch }, patch.deleted && !chat.last.deleted ? "deleted" : "edited", chat.last);
      return;
    }
    if (chat?.mediaCounts && id <= (chat.mediaCountsAt ?? 0) && (("body" in patch) || ("deleted" in patch))) {
      delete chat.mediaCounts;
      delete chat.mediaCountsAt;
      this.markChat(chat);
    }
  }
  pendingDrafts = new Set;
  applyRemoteDraft(chatId, text, at, entities) {
    const chat = this.chats.get(chatId);
    if (!chat)
      return;
    if (this.pendingDrafts.has(chatId))
      return;
    const next = text ? { text, at, ...entities?.length ? { entities } : {} } : null;
    if (sameDraft(chat.draft, next))
      return;
    chat.draft = next;
    this.markChat(chat);
  }
  setDraft(chatId, text, entities) {
    const chat = this.chats.get(chatId);
    if (!chat)
      return false;
    const next = text.trim() ? { text, at: new Date().toISOString(), ...entities?.length ? { entities } : {} } : null;
    if (sameDraft(chat.draft, next))
      return false;
    chat.draft = next;
    this.markChat(chat);
    return true;
  }
  async wipe(epoch, keep = {}) {
    const saved = keep.outbox ? [...this.outbox.values()] : [];
    const reads = keep.outbox ? new Map(this.pendingReads) : new Map;
    this.resetGen++;
    this.expiring.clear();
    this.expiredFiles.clear();
    for (const id of this.chats.keys())
      this.touch(id);
    this.chats.clear();
    this.chatV.clear();
    this.messages.clear();
    this.loaded.clear();
    this.sorted.clear();
    this.ids.clear();
    this.guests.clear();
    this.scheduled.clear();
    this.dirtyScheduled.clear();
    this.scheduledProgress.clear();
    this.scheduledCounts = null;
    this.outbox.clear();
    this.pendingReads.clear();
    this.profile.reset();
    this.contacts.reset();
    this.settings.reset();
    this.blocks.reset();
    this.members.reset();
    this.profileLists.reset();
    this.savedDialogs = new SavedDialogsCache;
    this.dirtyChats.clear();
    this.dirtyMessages.clear();
    this.dirtyOutbox.clear();
    this.dirtyReads.clear();
    this.rowPatches.clear();
    this.quotes.clear();
    this.quoteAsked.clear();
    this.quoteWants.clear();
    this.lastSeq = this.seqAtFlush = 0;
    this.chatSeq.clear();
    this.dirtyChatSeq.clear();
    this.seqHints.clear();
    this.since = 0;
    this.previews.clear();
    this.hydrated = false;
    this.dialogsAt = 0;
    this.dialogsId = 0;
    this.dialogsDone = false;
    this.pendingDrafts.clear();
    this.epoch = epoch;
    const db = this.db;
    const names = keep.outbox ? [...CACHE_STORES, "outbox"] : STORES;
    const t = db.transaction(names, "readwrite");
    for (const n of names)
      t.objectStore(n).clear();
    await new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    for (const o of saved)
      this.addPending(o);
    for (const [c, up] of reads) {
      this.pendingReads.set(c, up);
      this.dirtyReads.add(c);
    }
    this.dirtyMeta = true;
    await this.flush();
  }
  markMeta() {
    this.dirtyMeta = true;
  }
  setDialogsCursor(next, total) {
    if (total != null)
      this.dialogsTotal = total;
    this.dialogsAt = next ? Date.parse(next.at) : 0;
    this.dialogsId = next ? next.id : 0;
    this.dialogsDone = !next;
    this.dirtyMeta = true;
  }
  resetDialogs() {
    const keep = new Set([...this.outbox.values()].map((o) => o.chatId));
    for (const id of this.previews)
      keep.add(id);
    for (const id of [...this.chats.keys()])
      if (!keep.has(id)) {
        this.chats.delete(id);
        this.chatV.delete(id);
        this.messages.delete(id);
        this.loaded.delete(id);
        this.members.dropChat(id);
        this.dirtyChats.add(id);
        this.touch(id);
      }
    this.dialogsAt = 0;
    this.dialogsId = 0;
    this.dialogsDone = false;
    this.rowPatches.clear();
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }
  resetForSnapshot() {
    this.resetGen++;
    for (const chatId of [...this.chats.keys()]) {
      const map = this.messages.get(chatId);
      if (map) {
        for (const [k, m] of map)
          if (m.id != null) {
            map.delete(k);
          }
      }
      const c = this.chats.get(chatId);
      c.unread = 0;
      c.knownMaxId = 0;
      c.ranges = [];
      delete c.historyStart;
      delete c.snapLast;
      delete c.seed;
      delete c.threads;
      c.last = null;
      delete c.mediaCounts;
      delete c.mediaCountsAt;
      delete c.mediaDone;
      delete c.savedViews;
      this.markChat(c);
    }
    this.lastSeq = 0;
    for (const id of this.chatSeq.keys())
      this.dirtyChatSeq.add(id);
    this.chatSeq.clear();
    this.seqHints.clear();
    this.since = 0;
    this.rowPatches.clear();
    this.dirtyMeta = true;
    this.clearPersistedMessages = true;
  }
  clearPersistedMessages = false;
  async flush() {
    const t0 = Date.now();
    const live = new Set;
    for (const m of this.dirtyMessages.values())
      if (m.id != null)
        live.add(`${m.chatId}:${m.id}`);
    const batch = { put: {}, del: {}, rowPatches: [...this.rowPatches].filter(([k]) => !live.has(k)).map(([, v]) => v) };
    this.rowPatches.clear();
    if (this.clearPersistedMessages) {
      const t = this.db.transaction(["messages", "terms"], "readwrite");
      t.objectStore("messages").clear();
      t.objectStore("terms").clear();
      await new Promise((res, rej) => {
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
      this.clearPersistedMessages = false;
      this.staleTerms.clear();
      for (const map of this.messages.values())
        for (const m of map.values())
          this.dirtyMessages.set(m.key, m);
    }
    const held = [...this.dirtyChats].filter((id) => this.trimming.has(id) && this.chats.has(id));
    const kept = (chatId) => !this.previews.has(chatId);
    batch.put.chats = [...this.dirtyChats].filter((id) => !this.trimming.has(id) && kept(id)).map((id) => this.chats.get(id)).filter(Boolean);
    batch.del.chats = [...this.dirtyChats].filter((id) => !this.chats.has(id));
    batch.put.messages = [...this.dirtyMessages.values()].filter((m) => kept(m.chatId)).map((m) => {
      const tab = tabsOf(m)[0];
      return tab ? { ...m, tab } : m;
    });
    if (this.deletedMessages.size) {
      batch.del.messages = [...this.deletedMessages];
      this.deletedMessages.clear();
    }
    batch.put.chatSeq = [...this.dirtyChatSeq].filter((id) => this.chatSeq.has(id) && kept(id)).map((chatId) => ({ chatId, seq: this.chatSeq.get(chatId) }));
    batch.del.chatSeq = [...this.dirtyChatSeq].filter((id) => !this.chatSeq.has(id));
    this.dirtyChatSeq.clear();
    const termRows = [];
    const fresh = new Set;
    for (const m of this.dirtyMessages.values())
      if (kept(m.chatId))
        for (const term of termsOf(m)) {
          termRows.push({ term, chatId: m.chatId, sort: m.sort, key: m.key });
          fresh.add(termKey(term, m.chatId, m.sort));
        }
    batch.put.terms = termRows;
    batch.del.terms = [...this.staleTerms].filter(([k]) => !fresh.has(k)).map(([, v]) => v);
    this.staleTerms.clear();
    batch.put.outbox = [...this.dirtyOutbox].map((k) => this.outbox.get(k)).filter(Boolean);
    batch.del.outbox = [...this.dirtyOutbox].filter((k) => !this.outbox.has(k));
    batch.put.scheduled = [...this.dirtyScheduled].map((k) => this.scheduled.get(k)).filter(Boolean);
    batch.del.scheduled = [...this.dirtyScheduled].filter((k) => !this.scheduled.has(k));
    this.dirtyScheduled.clear();
    batch.put.pendingReads = [...this.dirtyReads].filter((c) => this.pendingReads.has(c)).map((c) => ({ chatId: c, upToId: this.pendingReads.get(c) }));
    batch.del.pendingReads = [...this.dirtyReads].filter((c) => !this.pendingReads.has(c));
    if (this.dirtyMeta || this.lastSeq !== this.seqAtFlush)
      batch.put.meta = [{ k: "lastSeq", v: this.lastSeq }, { k: "since", v: this.since }, { k: "clockSkew", v: this.clockSkew }, { k: "expiredFiles", v: [...this.expiredFiles] }, { k: "hydrated", v: this.hydrated ? 1 : 0 }, { k: "dialogsAt", v: this.dialogsAt }, { k: "dialogsId", v: this.dialogsId }, { k: "dialogsDone", v: this.dialogsDone ? 1 : 0 }, { k: "dialogsTotal", v: this.dialogsTotal }, ...this.epoch ? [{ k: "epoch", v: this.epoch }] : []];
    const prof = this.profile.collect();
    if (prof.me)
      batch.put.meta = [...batch.put.meta ?? [], prof.me];
    batch.put.users = prof.users;
    batch.del.users = prof.del;
    const contacts = this.contacts.collect();
    batch.put.contacts = contacts.put;
    batch.del.contacts = contacts.del;
    if (contacts.meta.length)
      batch.put.meta = [...batch.put.meta ?? [], ...contacts.meta];
    const settings = this.settings.collect();
    if (settings)
      batch.put.meta = [...batch.put.meta ?? [], settings];
    const blocks = this.blocks.collect();
    batch.put.blocked = blocks.put;
    batch.del.blocked = blocks.del;
    if (blocks.meta.length)
      batch.put.meta = [...batch.put.meta ?? [], ...blocks.meta];
    const members = this.members.collect();
    batch.put.members = members.put;
    batch.del.members = members.del;
    const lists = this.profileLists.collect();
    batch.put.profileMusic = lists.music.put;
    batch.del.profileMusic = lists.music.del;
    batch.put.profilePhotos = lists.photos.put;
    batch.del.profilePhotos = lists.photos.del;
    if (lists.meta)
      batch.put.meta = [...batch.put.meta ?? [], lists.meta];
    const saved = this.savedDialogs.collect();
    batch.put.savedDialogs = saved.put;
    batch.del.savedDialogs = saved.del;
    if (saved.meta)
      batch.put.meta = [...batch.put.meta ?? [], saved.meta];
    this.dirtyChats.clear();
    this.dirtyMessages.clear();
    this.dirtyOutbox.clear();
    this.dirtyReads.clear();
    this.dirtyMeta = false;
    for (const id of held)
      this.dirtyChats.add(id);
    const seq = this.lastSeq;
    await write(this.db, batch);
    this.seqAtFlush = seq;
    if (this.onFlush) {
      let keys = 0;
      for (const v of Object.values(batch.put))
        keys += v?.length ?? 0;
      for (const v of Object.values(batch.del))
        keys += v?.length ?? 0;
      if (keys)
        this.onFlush(keys, Date.now() - t0);
    }
  }
  map(chatId) {
    let m = this.messages.get(chatId);
    if (!m) {
      m = new Map;
      this.messages.set(chatId, m);
    }
    return m;
  }
  ensureChat(id) {
    let c = this.chats.get(id);
    if (!c) {
      c = { id, kind: "direct", lastReadId: 0, unread: 0, knownMaxId: 0, peerReadUpTo: 0, ranges: [], peerId: null, last: null, lastAt: new Date(0).toISOString() };
      const g = this.guests.get(id);
      if (g) {
        this.guests.delete(id);
        for (const t of g.open)
          if (g.threads[t])
            (c.threads ??= {})[t] = g.threads[t];
        for (const m of this.messages.get(id)?.values() ?? [])
          this.dirtyMessages.set(m.key, m);
      }
      this.chats.set(id, c);
      this.markChat(c);
    }
    return c;
  }
  putMessage(m) {
    const map = this.map(m.chatId), prev = map.get(m.key);
    map.set(m.key, m);
    if (this.isGuest(m.chatId)) {
      this.touch(m.chatId);
      return;
    }
    this.dirtyMessages.set(m.key, m);
    if (prev) {
      const now = new Set(termsOf(m));
      for (const t of termsOf(prev))
        if (!now.has(t) || prev.sort !== m.sort)
          this.staleTerms.set(termKey(t, prev.chatId, prev.sort), [t, prev.chatId, prev.sort]);
    }
    const chat = this.ensureChat(m.chatId);
    this.touch(m.chatId);
    onMessage(this, chat, m, !prev ? "added" : m.deleted && !prev.deleted ? "deleted" : "edited", prev);
  }
  chatV = new Map;
  chatVersion(id) {
    let v = this.chatV.get(id);
    if (v == null) {
      v = nextV();
      this.chatV.set(id, v);
    }
    return v;
  }
  noteOpened(chatId) {
    const c = this.chats.get(chatId);
    if (c) {
      c.openedAt = Date.now();
      this.dirtyChats.add(chatId);
    }
  }
  saveChat(c) {
    this.dirtyChats.add(c.id);
    this.touch(c.id);
  }
  dropMessages(chatId, list) {
    const map = this.messages.get(chatId);
    for (const { key, id } of list) {
      if (id != null)
        this.rowPatches.delete(`${chatId}:${id}`);
      if (map && !this.dirtyMessages.has(key))
        map.delete(key);
    }
    if (list.length) {
      this.trims.set(chatId, this.trimGen(chatId) + 1);
      this.touch(chatId);
    }
  }
  trimming = new Set;
  trimGen(chatId) {
    return this.trims.get(chatId) ?? 0;
  }
  trims = new Map;
  markChat(c) {
    this.dirtyChats.add(c.id);
    this.chatV.set(c.id, nextV());
    this.touch(c.id);
  }
  retouch(chatId) {
    this.touch(chatId);
  }
  touch(chatId) {
    this.touched.add(chatId);
    this.sorted.delete(chatId);
    this.ids.delete(chatId);
  }
  findChatOf(clientId) {
    for (const [chatId, map] of this.messages)
      if (map.has(clientId))
        return chatId;
    return null;
  }
}
var termKey = (term, chatId, sort) => `${term}\x00${chatId}\x00${sort}`;

// packages/sync-engine/src/multipart.ts
var PARALLEL = 4;
var URL_BATCH = 16;
var partLen = (s, size, n) => Math.min(s.partSize, size - (n - 1) * s.partSize);
async function uploadParts(blob, s, io) {
  const done = new Set(s.done);
  const queue = [];
  for (let n = 1;n <= s.parts; n++)
    if (!done.has(n))
      queue.push(n);
  let doneBytes = 0;
  for (const n of done)
    doneBytes += partLen(s, blob.size, n);
  const inflight = new Map;
  const report = () => {
    let b = doneBytes;
    for (const v of inflight.values())
      b += v;
    io.progress(b / blob.size);
  };
  report();
  if (!queue.length)
    return;
  const urls = new Map;
  let batch = null;
  const urlFor = async (n) => {
    while (!urls.has(n)) {
      if (!batch) {
        const want = [n, ...queue.filter((q) => !urls.has(q))].slice(0, URL_BATCH);
        batch = io.urls(want).then((r) => {
          for (const [k, v] of Object.entries(r))
            urls.set(Number(k), v);
        }).finally(() => {
          batch = null;
        });
      }
      await batch;
    }
    return urls.get(n);
  };
  const xhrs = new Set;
  let failure = null;
  const stop = (e) => {
    if (!failure) {
      failure = e;
      for (const x of xhrs)
        x.abort();
    }
  };
  io.register({ abort: () => stop({ code: io.cancelled() ? "cancelled" : "offline", retry: !io.cancelled() }) });
  let expired = 0;
  const worker = async () => {
    while (!failure && queue.length) {
      const n = queue.shift();
      try {
        const url = await urlFor(n);
        if (failure)
          return;
        const body = await blob.slice((n - 1) * s.partSize, (n - 1) * s.partSize + partLen(s, blob.size, n));
        if (failure)
          return;
        await putPart(url, body, xhrs, io, (loaded) => {
          inflight.set(n, loaded);
          report();
        });
        inflight.delete(n);
        done.add(n);
        doneBytes += partLen(s, blob.size, n);
        report();
        await io.saved([...done].sort((a, b) => a - b));
      } catch (e) {
        inflight.delete(n);
        if (e.status === 403 && ++expired <= 3) {
          urls.clear();
          queue.unshift(n);
          continue;
        }
        stop(io.cancelled() ? { code: "cancelled", retry: false } : e.code ? e : { code: "upload", retry: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  if (failure)
    throw failure;
}
function putPart(url, body, xhrs, io, progress) {
  const offline = { code: "offline", retry: true };
  if (io.offline())
    return Promise.reject(offline);
  const fail = (status) => status === 403 ? { status } : { code: "upload", retry: status >= 500 || status === 408 || status === 429, status };
  if (typeof XMLHttpRequest === "undefined") {
    const ac = new AbortController;
    xhrs.add(ac);
    return fetch(url, { method: "PUT", body, signal: ac.signal }).then((r) => {
      if (!r.ok)
        throw fail(r.status);
      progress(body.size);
    }, () => {
      throw offline;
    }).finally(() => xhrs.delete(ac));
  }
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest;
    x.open("PUT", url);
    let last = 0;
    x.upload.onprogress = (e) => {
      if (e.timeStamp - last < 100)
        return;
      last = e.timeStamp;
      progress(e.loaded);
    };
    x.onload = () => {
      xhrs.delete(x);
      if (x.status < 300)
        resolve();
      else
        reject(fail(x.status));
    };
    x.onerror = () => {
      xhrs.delete(x);
      reject(offline);
    };
    x.onabort = () => {
      xhrs.delete(x);
      reject(offline);
    };
    xhrs.add(x);
    x.send(body);
  });
}

// packages/sync-engine/src/transport.ts
var DROP_CODE = 4000;

class WsTransport {
  url;
  h;
  backoff;
  dev;
  wanted = false;
  ws = null;
  attempt = 0;
  timer = null;
  nextDelay = null;
  nextAt = null;
  inAt = 0;
  outAt = 0;
  inQueued = 0;
  outQueued = 0;
  constructor(url, h, backoff = [250, 5000], dev) {
    this.url = url;
    this.h = h;
    this.backoff = backoff;
    this.dev = dev;
  }
  start() {
    if (this.wanted)
      return;
    this.wanted = true;
    this.open();
  }
  stop() {
    this.wanted = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAt = this.nextDelay = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
      this.dev?.log.closed();
      this.h.onClose();
    }
  }
  retryNow() {
    if (!this.wanted || this.ws || !this.timer)
      return;
    clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.open();
  }
  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  send(f) {
    if (!this.isOpen() || this.dev?.sim.offline)
      return false;
    const s = JSON.stringify(f);
    this.dev?.log.frameOut(f, s.length);
    const p = this.dev?.sim.profile ?? null;
    if (!p && !this.outQueued) {
      this.ws.send(s);
      return true;
    }
    if (f.op !== "hello" && lost(p)) {
      this.dev.sim.losses++;
      this.dev.log.record("engine", "lost", { dir: "out", op: f.op });
      return true;
    }
    const ws = this.ws;
    this.outQueued++;
    this.later("out", p ? oneWay(p, s.length) : 0, () => {
      this.outQueued--;
      if (ws.readyState === WebSocket.OPEN)
        ws.send(s);
    });
    return true;
  }
  drop() {
    const ws = this.ws;
    if (!ws)
      return;
    try {
      ws.close(DROP_CODE, "drop");
    } catch {
      ws.close();
    }
  }
  setOffline(on) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAt = this.nextDelay = null;
    if (on) {
      this.ws?.close();
      return;
    }
    if (!this.wanted || this.ws)
      return;
    this.attempt = 0;
    this.open();
  }
  view() {
    const rs = this.ws?.readyState;
    const state = rs === WebSocket.OPEN ? "open" : rs === WebSocket.CONNECTING ? "connecting" : this.dev?.sim.offline ? "offline" : this.timer ? "waiting" : "closed";
    return { state, attempt: this.attempt, nextDelay: this.nextDelay, nextAt: this.nextAt };
  }
  later(dir, delay, fn) {
    const now = Date.now();
    const at = Math.max(dir === "in" ? this.inAt : this.outAt, now + delay);
    if (dir === "in")
      this.inAt = at;
    else
      this.outAt = at;
    setTimeout(fn, at - now);
  }
  deliver(ws, size, fn) {
    const p = this.dev?.sim.profile ?? null;
    if (!p && !this.inQueued) {
      fn();
      return;
    }
    this.inQueued++;
    this.later("in", p ? oneWay(p, size) : 0, () => {
      this.inQueued--;
      if (this.ws === ws)
        fn();
    });
  }
  receive(raw) {
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    const dev = this.dev;
    if (dev) {
      const sim = dev.sim;
      if (f.op !== "hello" && f.op !== "challenge" && f.op !== "sessionTerminated" && lost(sim.profile)) {
        sim.losses++;
        dev.log.frameIn(f, raw.length, "lost");
        return;
      }
      if (f.op === "updates" && sim.dropNextUpdates) {
        sim.dropNextUpdates = false;
        sim.losses++;
        dev.log.frameIn(f, raw.length, "dropped");
        return;
      }
      if (f.op === "push" && sim.dropNextUpdates) {
        sim.losses++;
        dev.log.frameIn(f, raw.length, "dropped");
        f = { op: "poke" };
      }
      if (f.op === "updates" && sim.forceTooLong) {
        sim.forceTooLong = false;
        dev.log.frameIn(f, raw.length, "asTooLong");
        f = { op: "tooLong", seq: f.to };
      }
      dev.log.frameIn(f, raw.length);
    }
    this.h.onFrame(f);
  }
  open() {
    if (this.dev?.sim.offline)
      return;
    this.nextAt = this.nextDelay = null;
    this.dev?.log.record("engine", "connect", { attempt: this.attempt });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.deliver(ws, 0, () => {
      this.attempt = 0;
      this.dev?.log.record("engine", "open", null);
      this.h.onOpen();
    });
    ws.onmessage = (e) => {
      const raw = String(e.data);
      if (!this.inQueued && !this.dev?.sim.profile)
        this.receive(raw);
      else
        this.deliver(ws, raw.length, () => this.receive(raw));
    };
    ws.onerror = () => {};
    ws.onclose = (e) => this.deliver(ws, 0, () => {
      if (this.ws !== ws)
        return;
      this.ws = null;
      this.dev?.log.closed();
      this.dev?.log.record("engine", "close", { code: e?.code ?? null });
      this.h.onClose();
      if (!this.wanted || this.dev?.sim.offline)
        return;
      const base = Math.min(this.backoff[1], this.backoff[0] * 2 ** this.attempt++);
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      this.nextDelay = delay;
      this.nextAt = Date.now() + delay;
      this.dev?.log.record("engine", "backoff", { attempt: this.attempt, delay });
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted)
          this.open();
      }, delay);
    });
  }
}

// packages/sync-engine/src/ops.ts
var MAX_FAILURES = 20;
var plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
async function loadOps(db) {
  return (await getAll(db, "ops")).sort((a, b) => a.id - b.id);
}

class Ops {
  db;
  http;
  hooks;
  list;
  failures = [];
  dirty = false;
  inflight = null;
  pumping = false;
  retryTimer = null;
  attempt = 0;
  nextId;
  nextFailure = 1;
  closed = false;
  gen = 0;
  constructor(db, list, http, hooks) {
    this.db = db;
    this.http = http;
    this.hooks = hooks;
    this.list = list;
    this.nextId = list.reduce((m, o) => Math.max(m, o.id), 0) + 1;
  }
  async enqueue(spec) {
    const i = this.list.findIndex((o) => o.key === spec.key && o.id !== this.inflight);
    const op = { id: i >= 0 ? this.list[i].id : this.nextId++, key: spec.key, method: spec.method, path: spec.path, at: Date.now() };
    if (spec.body !== undefined)
      op.body = spec.body;
    if (i >= 0) {
      const old = this.list[i];
      if (old.method === "PATCH" && op.method === "PATCH" && old.path === op.path && plain(old.body) && plain(op.body))
        op.body = { ...old.body, ...op.body };
      this.list = this.list.map((o, k) => k === i ? op : o);
    } else {
      this.list = [...this.list, op];
    }
    this.dirty = true;
    this.hooks.changed();
    await write(this.db, { put: { ops: [op] }, del: {} });
    this.kick();
  }
  get busy() {
    return this.pumping;
  }
  get sending() {
    return this.pumping || this.list.length > 0 && !this.retryTimer && this.hooks.canSend();
  }
  resume() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempt = 0;
    this.kick();
  }
  kick() {
    if (this.pumping || this.closed || this.retryTimer || !this.list.length || !this.hooks.canSend())
      return;
    this.pumping = true;
    this.hooks.run(async () => {
      try {
        while (!this.closed && this.hooks.canSend()) {
          const op = this.list[0];
          if (!op)
            break;
          this.inflight = op.id;
          const gen = this.gen;
          const r = await this.send(op);
          this.inflight = null;
          if (this.closed)
            break;
          if (gen !== this.gen)
            continue;
          if ("retry" in r) {
            this.backoff();
            break;
          }
          this.attempt = 0;
          this.list = this.list.filter((o) => o.id !== op.id);
          this.hooks.log?.(r.ok ? "opAck" : "opFail", r.ok ? { key: op.key } : { key: op.key, code: r.code });
          if (r.ok)
            this.hooks.done(op, r.value);
          else {
            this.failures = [...this.failures, { id: this.nextFailure++, key: op.key, code: r.code, at: Date.now() }].slice(-MAX_FAILURES);
          }
          this.dirty = true;
          this.hooks.changed();
          await write(this.db, { put: {}, del: { ops: [op.id] } });
        }
      } finally {
        this.inflight = null;
        this.pumping = false;
      }
    });
  }
  forget() {
    this.gen++;
    this.list = [];
    this.dirty = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
  item() {
    return { key: "ops", pending: this.list.length, keys: [...new Set(this.list.map((o) => o.key))], failures: this.failures };
  }
  backoff() {
    const [min, max] = this.http.backoffMs ?? [500, 30000];
    const ms = Math.min(max, min * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, ms);
  }
  async send(op) {
    try {
      const res = await (this.http.fetch ?? fetch)(this.http.base + op.path, {
        method: op.method,
        headers: { "content-type": "application/json", ...this.http.headers ?? {} },
        credentials: "include",
        body: op.body === undefined ? undefined : JSON.stringify(op.body)
      });
      if (res.ok)
        return { ok: true, value: await res.json().catch(() => null) };
      if (res.status === 401) {
        this.hooks.unauthorized?.();
        return { retry: true };
      }
      if (res.status >= 500 || res.status === 408 || res.status === 429)
        return { retry: true };
      const j = await res.json().catch(() => null);
      return { ok: false, code: typeof j?.code === "string" ? j.code : "http_" + res.status };
    } catch {
      return { retry: true };
    }
  }
}

// packages/sync-engine/src/channelPost.ts
var key = (id) => "cpost:" + id;

class ChannelPosts {
  h;
  mem = new Map;
  constructor(h) {
    this.h = h;
  }
  async load(id) {
    const hit = this.mem.get(id);
    if (hit)
      return hit;
    const row = await req(this.h.db.transaction("meta").objectStore("meta").get(key(id))).catch(() => {
      return;
    });
    if (row)
      this.mem.set(id, row.v);
    return row?.v ?? null;
  }
  save(id, v) {
    if (v)
      this.mem.set(id, v);
    else
      this.mem.delete(id);
    const os = this.h.db.transaction("meta", "readwrite").objectStore("meta");
    (v ? req(os.put({ k: key(id), v })) : req(os.delete(key(id)))).catch(() => {});
  }
  async get(chatId, cached = false) {
    const prev = await this.load(chatId);
    if (cached || !this.h.online())
      return prev;
    let res;
    try {
      res = await this.h.fetch(`/groups/${chatId}`);
    } catch {
      return prev;
    }
    if (res.status === 403 || res.status === 404) {
      this.save(chatId, null);
      return { gone: true };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.chat)
      return prev;
    const v = { last: data.chat.last ?? null, at: Date.now() };
    this.save(chatId, v);
    return v;
  }
}

// packages/sync-engine/src/stickers.ts
var MINE = "stickers:mine";
var setKey = (id) => "stickers:set:" + id;
var EMPTY = { sets: [], recent: [], faved: [] };

class Stickers {
  h;
  mine = null;
  sets = new Map;
  installs = new Map;
  faves = new Map;
  unrecent = new Map;
  constructor(h) {
    this.h = h;
  }
  async load(k) {
    const row = await req(this.h.db.transaction("meta").objectStore("meta").get(k));
    return row ? row.v : null;
  }
  save(k, v) {
    req(this.h.db.transaction("meta", "readwrite").objectStore("meta").put({ k, v })).catch(() => {});
  }
  async cachedMine() {
    if (!this.mine) {
      const loaded = await this.load(MINE);
      this.mine ??= loaded;
    }
    return this.mine ?? EMPTY;
  }
  setMine(m, persist = true) {
    this.mine = m;
    if (persist)
      this.save(MINE, m);
  }
  async bumpRecent(s) {
    const m = await this.cachedMine();
    this.setMine({ ...m, recent: [s, ...m.recent.filter((x) => x.id !== s.id)].slice(0, RECENT_STICKERS_LIMIT) });
    this.h.bump();
  }
  async act(a) {
    switch (a.type) {
      case "myStickers": {
        const cached = await this.cachedMine();
        if (!this.h.online())
          return { ...cached, offline: true };
        try {
          const unsent = this.h.unsentStickers();
          const answer = await this.h.http("/my-stickers");
          const fresh = this.overlay(answer, [...unsent, ...this.h.unsentStickers()]);
          this.setMine(fresh);
          return fresh;
        } catch {
          return { ...cached, offline: true };
        }
      }
      case "stickerSet": {
        const id = String(a.id);
        let hit = this.sets.get(id) ?? await this.load(setKey(id));
        if (hit && (a.hash == null || hit.hash === a.hash)) {
          this.sets.set(id, hit);
          return hit;
        }
        if (!this.h.online())
          return hit ?? null;
        try {
          const set = await this.h.http(`/sticker-sets/${encodeURIComponent(id)}`);
          for (const k of [String(set.id), set.shortName]) {
            this.sets.set(k, set);
            this.save(setKey(k), set);
          }
          return set;
        } catch {
          return hit ?? null;
        }
      }
      case "installStickerSet": {
        this.installs.set(a.setId, { on: a.on, info: a.info, at: Date.now() });
        const m = await this.cachedMine();
        if (!a.on)
          this.setMine({ ...m, sets: m.sets.filter((s) => s.id !== a.setId) });
        else if (a.info && !m.sets.some((s) => s.id === a.setId))
          this.setMine({ ...m, sets: [a.info, ...m.sets] });
        this.h.bump();
        await this.h.enqueue({ key: "stickers:set:" + a.setId, method: "POST", path: "/my-stickers/sets", body: { setId: a.setId, on: a.on } });
        return null;
      }
      case "faveSticker": {
        this.faves.set(a.id, { on: a.on, sticker: a.sticker, at: Date.now() });
        const m = await this.cachedMine();
        const faved = a.on && a.sticker ? [a.sticker, ...m.faved.filter((x) => x.id !== a.id)].slice(0, FAVED_STICKERS_LIMIT) : m.faved.filter((x) => x.id !== a.id);
        this.setMine({ ...m, faved });
        this.h.bump();
        await this.h.enqueue({ key: "stickers:fave:" + a.id, method: "POST", path: "/my-stickers/faved", body: { id: a.id, on: a.on } });
        return null;
      }
      case "clearRecentStickers": {
        this.unrecent.set(a.id ?? "all", Date.now());
        const m = await this.cachedMine();
        this.setMine({ ...m, recent: a.id != null ? m.recent.filter((x) => x.id !== a.id) : [] });
        this.h.bump();
        await this.h.enqueue({ key: "stickers:recent:" + (a.id ?? "all"), method: "DELETE", path: "/my-stickers/recent" + (a.id != null ? `?id=${a.id}` : "") });
        return null;
      }
      case "featuredStickerSets":
        if (!this.h.online())
          return [];
        return this.h.http(`/sticker-sets/featured?offset=${a.offset ?? 0}`).catch(() => []);
      case "searchStickerSets":
        if (!this.h.online())
          return [];
        return this.h.http(`/sticker-sets/search?q=${encodeURIComponent(a.q)}`).catch(() => []);
      case "stickersByEmoji": {
        const local = () => this.localByEmoji(a.emoji);
        if (!this.h.online())
          return local();
        return this.h.http(`/stickers-by-emoji?e=${encodeURIComponent(a.emoji)}`).catch(local);
      }
      case "greetingSticker":
        if (!this.h.online())
          return null;
        return this.h.http("/stickers/greeting").catch(() => null);
    }
  }
  overlay(m, unsent) {
    const stale = Date.now() - 60000;
    const cleared = new Map(this.unrecent);
    let { sets, recent, faved } = m;
    for (const [id, o] of this.installs) {
      const has = sets.some((s) => s.id === id);
      if (has === o.on || o.at < stale) {
        this.installs.delete(id);
        continue;
      }
      sets = o.on ? o.info ? [o.info, ...sets] : sets : sets.filter((s) => s.id !== id);
    }
    for (const [id, o] of this.faves) {
      const has = faved.some((s) => s.id === id);
      if (has === o.on || o.at < stale) {
        this.faves.delete(id);
        continue;
      }
      faved = o.on ? o.sticker ? [o.sticker, ...faved].slice(0, FAVED_STICKERS_LIMIT) : faved : faved.filter((s) => s.id !== id);
    }
    for (const [id, at] of this.unrecent) {
      const left = id === "all" ? recent.length > 0 : recent.some((s) => s.id === id);
      if (!left || at < stale) {
        this.unrecent.delete(id);
        continue;
      }
      recent = id === "all" ? [] : recent.filter((s) => s.id !== id);
    }
    for (const { sticker, at } of unsent.sort((x, y) => x.at - y.at)) {
      if (at < (cleared.get("all") ?? 0) || at < (cleared.get(sticker.id) ?? 0))
        continue;
      recent = [sticker, ...recent.filter((s) => s.id !== sticker.id)].slice(0, RECENT_STICKERS_LIMIT);
    }
    return { sets, recent, faved };
  }
  async localByEmoji(emoji) {
    const want = new Set([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(emoji.replace(/\s+/g, ""))].map((x) => x.segment.replace(/️/g, "")));
    const m = await this.cachedMine();
    const seen = new Set, out = [];
    for (const s of [...m.recent, ...[...this.sets.values()].flatMap((x) => x.stickers)]) {
      if (want.has(s.emoji.replace(/️/g, "")) && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
    return out;
  }
}

// packages/sync-engine/src/savedGifs.ts
var OP_GIF = "gifs:";
var META = "gifs:mine";

class SavedGifs {
  h;
  base = null;
  edits = new Map;
  loaded = null;
  synced = -1;
  fetching = false;
  acks = 0;
  constructor(h) {
    this.h = h;
  }
  load() {
    return this.loaded ??= (async () => {
      const row = await req(this.h.db.transaction("meta").objectStore("meta").get(META));
      if (!row)
        return;
      this.base = row.v.base;
      this.edits = new Map(row.v.edits);
    })().catch(() => {});
  }
  save() {
    const v = { base: this.base, edits: [...this.edits] };
    req(this.h.db.transaction("meta", "readwrite").objectStore("meta").put({ k: META, v })).catch(() => {});
  }
  bumpOwn() {
    const fresh = this.synced === this.h.rev();
    this.h.bump();
    if (fresh)
      this.synced = this.h.rev();
  }
  view() {
    let list = this.base ?? [];
    for (const [id, e] of this.edits) {
      list = list.filter((g) => g.id !== id);
      if (e.on && e.gif)
        list = [e.gif, ...list];
    }
    return [...list].sort((a, b) => b.savedAt - a.savedAt).slice(0, SAVED_GIFS_LIMIT);
  }
  has(id) {
    return this.view().some((g) => g.id === id);
  }
  async act(a) {
    await this.load();
    switch (a.type) {
      case "savedGifs":
        this.sync();
        return { list: this.view(), loaded: this.base !== null || !this.h.online() };
      case "saveGif": {
        this.edits.set(a.gif.id, { on: true, gif: { ...a.gif, savedAt: Date.now() } });
        this.save();
        this.bumpOwn();
        await this.h.enqueue({ key: OP_GIF + a.gif.id, method: "POST", path: "/my-gifs", body: { chatId: a.chatId, messageId: a.messageId } });
        return null;
      }
      case "removeGif": {
        this.edits.set(a.id, { on: false });
        this.save();
        this.bumpOwn();
        await this.h.enqueue({ key: OP_GIF + a.id, method: "DELETE", path: `/my-gifs/${encodeURIComponent(a.id)}` });
        return null;
      }
    }
  }
  sync() {
    if (this.fetching || !this.h.online() || this.synced === this.h.rev())
      return;
    this.fetching = true;
    const at = this.h.rev(), acks = this.acks;
    this.h.run(async () => {
      try {
        const known = new Map;
        for (const g of this.base ?? [])
          known.set(g.id, g);
        for (const e of this.edits.values())
          if (e.gif)
            known.set(e.gif.id, e.gif);
        const r = await this.h.http("/my-gifs/list", { method: "POST", body: JSON.stringify({ have: [...known.keys()].filter((id) => !!known.get(id).key || !known.get(id).enc) }) });
        if (acks !== this.acks)
          return;
        const next = r.list.map((g) => {
          const k = known.get(g.id);
          return k && g.key === undefined ? { ...g, name: k.name, ...k.key ? { key: k.key } : {}, thumb: k.thumb ?? null } : g;
        });
        const before = JSON.stringify(this.view());
        this.base = next;
        for (const id of this.edits.keys())
          if (!this.h.pending(OP_GIF + id))
            this.edits.delete(id);
        this.save();
        this.synced = at;
        if (JSON.stringify(this.view()) !== before)
          this.bumpOwn();
      } catch {} finally {
        this.fetching = false;
        if (this.synced !== this.h.rev())
          this.sync();
      }
    });
  }
  opDone(op, value) {
    const id = op.key.slice(OP_GIF.length);
    this.acks++;
    if (op.method === "POST") {
      const v = value;
      if (v?.gif) {
        const gone = new Set(v.evicted ?? []);
        this.base = [v.gif, ...(this.base ?? []).filter((g) => g.id !== v.gif.id && !gone.has(g.id))];
      }
    } else if (this.base)
      this.base = this.base.filter((g) => g.id !== id);
    if (!this.h.pending(op.key))
      this.edits.delete(id);
    this.save();
    this.bumpOwn();
  }
  opFailed(key) {
    const id = key.slice(OP_GIF.length);
    if (!this.h.pending(key))
      this.edits.delete(id);
    this.save();
    this.acks++;
    this.synced = -1;
    this.h.bump();
  }
}

// packages/sync-engine/src/session.ts
var WAIT_MS = 3000;
var PROBE_MS = 3000;

class SessionEnd {
  h;
  reason = null;
  done = () => {};
  lastProbe = 0;
  constructor(h) {
    this.h = h;
  }
  get ended() {
    return this.reason !== null;
  }
  onDone(cb) {
    this.done = cb;
  }
  status() {
    return this.reason ? { terminated: true, terminatedReason: this.reason } : {};
  }
  end(reason = "terminated") {
    if (this.reason || this.h.closed())
      return;
    this.reason = reason;
    this.h.stop();
    this.h.notify();
    this.h.run(async () => {
      const until = Date.now() + WAIT_MS;
      while (this.h.working() && Date.now() < until)
        await new Promise((r) => setTimeout(r, 10));
      if (!this.h.shutdown())
        return;
      try {
        await this.h.wipe();
      } catch {}
      this.done();
    });
  }
  unauthorized(status) {
    if (status !== 401)
      return false;
    this.end("terminated");
    return true;
  }
  probe() {
    if (this.reason || this.h.closed() || Date.now() - this.lastProbe < PROBE_MS)
      return;
    this.lastProbe = Date.now();
    (this.h.fetch ?? fetch)(this.h.httpBase + "/me", { headers: this.h.headers, credentials: "include" }).then((r) => {
      this.unauthorized(r.status);
    }, () => {});
  }
}

// packages/sync-engine/src/globalSearch.ts
function nameWords(text) {
  return text.normalize("NFC").toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 64);
}
var fitsWords = (q, own) => q.every((w) => own.some((t) => t.startsWith(w)));
function localPeople(store, contacts, meId, raw, limit = 20) {
  const q = nameWords(raw.trim().replace(/^@/, ""));
  if (!q.length)
    return [];
  const direct = new Map;
  const ids = new Set(contacts.keys());
  for (const c of store.chats.values()) {
    if (c.kind === "direct") {
      if (c.peerId != null) {
        ids.add(c.peerId);
        if (!direct.has(c.peerId))
          direct.set(c.peerId, c.id);
      }
    } else
      for (const m of store.members.list(c.id))
        ids.add(m.userId);
  }
  const out = [];
  for (const id of ids) {
    if (id === meId)
      continue;
    const u = store.users.get(id) ?? contacts.get(id)?.user, c = contacts.get(id);
    if (u?.system)
      continue;
    const name = displayName(store, id) || (c ? contactName(c) : "");
    if (!name)
      continue;
    const username = u?.username ?? null;
    const own = [...nameWords(name), ...nameWords(u?.publicName ?? u?.name ?? ""), ...username ? [username.toLowerCase()] : []];
    if (!fitsWords(q, own))
      continue;
    out.push({ id, name, username, photo: u?.photo ?? null, chatId: direct.get(id) ?? null, contact: !!c });
  }
  out.sort((a, b) => Number(b.contact) - Number(a.contact) || a.name.localeCompare(b.name, "ru"));
  return out.slice(0, limit).map(({ contact: _c, ...p }) => p);
}
var MEDIA_BUDGET = 6000;
var MEDIA_CHUNK = 100;
async function localMedia(db, store, kind, raw, before, limit = 40, budget = MEDIA_BUDGET) {
  const q = nameWords(raw.trim());
  const upper = before ?? Infinity;
  const fits = (m) => {
    if (m.id == null || !tabsOf(m).includes(kind))
      return false;
    if (!q.length)
      return true;
    const a = m.attachment;
    const text = kind === "link" ? m.body : [m.body, a?.name, a?.title, a?.performer].filter(Boolean).join(" ");
    return fitsWords(q, nameWords(text));
  };
  const scans = [];
  for (const c of store.chats.values()) {
    const counts = c.mediaCounts;
    if (counts?.[kind] === 0)
      continue;
    const mains = kind === "link" ? MEDIA_TABS.filter((t) => t === "link" || counts?.[t] !== 0) : [kind];
    for (const tab of mains)
      scans.push({ chatId: c.id, tab, stop: upper, done: false, hits: 0 });
  }
  const found = new Map;
  let scanned = 0, first = true;
  const step = (index, sc, n) => new Promise((resolve, reject) => {
    let read = 0;
    const r = index.openCursor(IDBKeyRange.bound([sc.chatId, sc.tab, -Infinity], [sc.chatId, sc.tab, sc.stop], false, true), "prev");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cur = r.result;
      if (!cur) {
        sc.done = true;
        return resolve();
      }
      if (read >= n)
        return resolve();
      read++;
      scanned++;
      const row = cur.value;
      sc.stop = row.sort;
      const m = store.loadedMessage(sc.chatId, row.key) ?? row;
      if (fits(m)) {
        found.set(m.key, m);
        sc.hits++;
      }
      if (sc.hits > limit)
        return resolve();
      cur.continue();
    };
  });
  const frontier = () => scans.reduce((f, sc) => sc.done ? f : Math.max(f, sc.stop), -Infinity);
  const above = () => [...found.values()].filter((m) => m.id >= frontier()).sort((a, b) => b.id - a.id);
  for (;; ) {
    const active = scans.filter((sc) => !sc.done && sc.hits <= limit);
    const left = budget - scanned;
    if (!active.length || !first && left <= 0)
      break;
    const share = Math.min(MEDIA_CHUNK, Math.max(first ? 1 : 0, Math.floor(left / active.length)));
    if (share <= 0) {
      active.sort((a, b) => b.stop - a.stop);
      const index = db.transaction("messages").objectStore("messages").index("byTab");
      await step(index, active[0], left);
    } else {
      const index = db.transaction("messages").objectStore("messages").index("byTab");
      await Promise.all(active.map((sc) => step(index, sc, share)));
    }
    first = false;
    if (above().length >= limit)
      break;
  }
  const list = above(), page = list.slice(0, limit), f = frontier();
  const next = list.length > limit ? page[page.length - 1].id : f > -Infinity ? f : undefined;
  return {
    hits: page.map((m) => {
      const c = store.chats.get(m.chatId);
      return { message: toMessage(m), chatTitle: c ? chatTitle(store, c) : null, chatKind: c?.kind ?? "direct" };
    }),
    hasMore: next !== undefined,
    ...next !== undefined ? { next } : {},
    scanned
  };
}
function toMessage(m) {
  const { key: _k, sort: _s, status: _st, progress: _p, ...rest } = m;
  delete rest.tab;
  return { ...rest, id: m.id };
}
function localTop(store, limit = 10) {
  return [...store.chats.values()].filter((c) => c.kind === "direct" && !c.system && c.peerId != null && c.last).sort((a, b) => a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0).slice(0, limit).map((c) => c.id);
}

// packages/sync-engine/src/media.ts
var tabsCache = new WeakMap;
function tabMessages(store, chatId, tab, savedPeer) {
  const all = store.chatMessages(chatId);
  if (savedPeer)
    return savedTab(store, chatId, all, tab, savedPeer);
  let by = tabsCache.get(all);
  if (!by) {
    by = new Map;
    for (const m of all)
      for (const t of tabsOf(m)) {
        let l = by.get(t);
        if (!l) {
          l = [];
          by.set(t, l);
        }
        l.push(m);
      }
    tabsCache.set(all, by);
  }
  return by.get(tab) ?? [];
}
var peerTabs = new WeakMap;
function savedTab(store, chatId, all, tab, peer) {
  let by = peerTabs.get(all);
  if (!by) {
    by = new Map;
    peerTabs.set(all, by);
  }
  const k = peer + ":" + tab;
  let list = by.get(k);
  if (!list) {
    list = tabMessages(store, chatId, tab).filter((m) => m.savedPeer === peer);
    by.set(k, list);
  }
  return list;
}
var holder = (chat, peer) => peer ? chat?.savedViews?.[peer] : chat;
function mediaFloor(chat, tab, savedPeer) {
  if (!chat)
    return Infinity;
  const done = holder(chat, savedPeer)?.mediaDone?.[tab], live = chat.ranges[chat.ranges.length - 1];
  if (done === true || chat.historyStart && chat.ranges.length === 1)
    return true;
  return Math.min(done ?? Infinity, live ? live[0] : Infinity);
}
function visible(store, q) {
  const all = tabMessages(store, q.chatId, q.tab, q.savedPeer), floor = mediaFloor(store.chats.get(q.chatId), q.tab, q.savedPeer);
  let lo = 0;
  if (floor !== true)
    while (lo < all.length && all[lo].sort < floor)
      lo++;
  const from = Math.max(lo, all.length - q.limit);
  return { list: all.slice(from).reverse(), more: from > lo || floor !== true, floor };
}
function mediaResult(store, q, loading) {
  const items = new Map, sig = new Map, order = [];
  const { list, more } = visible(store, q);
  for (const m of list) {
    const { item, sig: g } = messageItem(m, null);
    items.set(item.key, item);
    sig.set(item.key, g);
    order.push(item.key);
  }
  const counts = holder(store.chats.get(q.chatId), q.savedPeer)?.mediaCounts ?? null;
  const meta = { key: "~media", done: !more, loading: loading || !store.isLoaded(q.chatId), counts: counts ? { ...counts } : null };
  items.set(meta.key, meta);
  sig.set(meta.key, JSON.stringify(meta));
  order.push(meta.key);
  return { items, order, sig };
}
var MEDIA_LOAD_RETRY_MS = 5000;

class MediaLoader {
  store;
  deps;
  busy = new Set;
  failed = new Set;
  retryAt = new Map;
  constructor(store, deps) {
    this.store = store;
    this.deps = deps;
  }
  busyChats() {
    const out = new Set;
    for (const k of this.busy)
      out.add(parseInt(k.startsWith("load:") || k.startsWith("counts:") ? k.slice(k.indexOf(":") + 1) : k, 10));
    return out;
  }
  loading(chatId, tab, savedPeer) {
    return this.busy.has(chatId + ":" + tab + (savedPeer ? ":" + savedPeer : "")) || this.busy.has("load:" + chatId) || !!savedPeer && this.busy.has("counts:" + chatId + ":" + savedPeer);
  }
  reconnect() {
    this.failed.clear();
    this.retryAt.clear();
  }
  want(q) {
    const { chatId, tab, savedPeer } = q;
    if (!this.store.isLoaded(chatId)) {
      this.task("load:" + chatId, chatId, async () => {
        await this.store.loadChatMessages(chatId);
      }, false);
      return;
    }
    const chat = this.store.chats.get(chatId);
    if (!chat || !this.deps.online())
      return;
    const qs = savedPeer ? "&savedPeer=" + encodeURIComponent(savedPeer) : "";
    const view = () => {
      const c = this.store.chats.get(chatId);
      return c && savedPeer ? (c.savedViews ??= {})[savedPeer] ??= {} : c;
    };
    if (!holder(chat, savedPeer)?.mediaCounts) {
      this.task("counts:" + chatId + (savedPeer ? ":" + savedPeer : ""), chatId, async () => {
        const gen = this.store.resetGen;
        const r = await this.deps.http(`/chats/${chatId}/media/counts${savedPeer ? "?savedPeer=" + encodeURIComponent(savedPeer) : ""}`);
        const c = this.store.chats.get(chatId), h = view();
        if (!c || !h || gen !== this.store.resetGen)
          return;
        h.mediaCounts = { media: r.media ?? 0, file: r.file ?? 0, audio: r.audio ?? 0, voice: r.voice ?? 0, link: r.link ?? 0, ...typeof r.video === "number" ? { video: r.video } : {} };
        h.mediaCountsAt = c.knownMaxId;
        this.store.markChat(c);
      });
    }
    const v = visible(this.store, q);
    if (v.floor === true || v.list.length >= q.limit)
      return;
    const floor = v.floor;
    this.task(chatId + ":" + tab + (savedPeer ? ":" + savedPeer : ""), chatId, async () => {
      const gen = this.store.resetGen, trims = this.store.trimGen(chatId);
      const r = await this.deps.http(`/chats/${chatId}/media?kind=${tab}${Number.isFinite(floor) ? "&beforeId=" + floor : ""}${qs}`);
      const c = this.store.chats.get(chatId), h = view();
      if (!c || !h || gen !== this.store.resetGen)
        return;
      this.store.addLoose(chatId, r.messages);
      if (trims !== this.store.trimGen(chatId))
        return;
      let lo = floor;
      for (const m of r.messages)
        if (m.id < lo)
          lo = m.id;
      h.mediaDone = { ...h.mediaDone, [tab]: r.hasMore && r.messages.length ? lo : true };
      this.store.markChat(c);
    });
  }
  task(key, chatId, fn, net = true) {
    if (this.busy.has(key) || this.failed.has(key) || (this.retryAt.get(key) ?? 0) > Date.now())
      return;
    this.busy.add(key);
    this.store.retouch(chatId);
    this.deps.run(async () => {
      try {
        await fn();
        await this.store.flush();
      } catch (err) {
        if (net)
          this.failed.add(key);
        else
          this.retryAt.set(key, Date.now() + MEDIA_LOAD_RETRY_MS);
        throw err;
      } finally {
        this.busy.delete(key);
        this.store.retouch(chatId);
        this.deps.changed();
      }
    });
  }
}

// packages/sync-engine/src/evict.ts
var EVICT_LIMITS = { perChat: 500, total: 50000, stale: 50, people: 5000 };
var EVICT_CHUNK = 300;
var serverRange = (chatId) => IDBKeyRange.bound([chatId, -Infinity], [chatId, PENDING_BASE], false, true);
function done(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
async function countAll(db, ids) {
  const out = new Map;
  const t = db.transaction("messages"), ix = t.objectStore("messages").index("byChat");
  for (const id of ids) {
    const r = ix.count(serverRange(id));
    r.onsuccess = () => out.set(id, r.result);
  }
  await done(t);
  return out;
}
async function floorOf(db, chatId, keep) {
  const t = db.transaction("messages"), top = t.objectStore("messages").index("byChat").openCursor(serverRange(chatId), "prev");
  let floor = null, skipped = keep <= 1;
  top.onsuccess = () => {
    const c = top.result;
    if (!c)
      return;
    if (!skipped) {
      skipped = true;
      c.advance(keep - 1);
      return;
    }
    floor = c.value.sort;
  };
  await done(t);
  return floor;
}
async function trimChunk(db, chatId, from, floor, chunk, prot, keptBefore) {
  const t = db.transaction(["messages", "terms", "chats"], "readwrite");
  const terms = t.objectStore("terms"), chats = t.objectStore("chats");
  const removed = [], kept = [];
  let next = null, seen = 0, row;
  const get = chats.get(chatId);
  get.onsuccess = () => {
    row = get.result;
  };
  const finish = () => {
    if (!removed.length || !row?.ranges)
      return;
    narrow(row, next ?? floor, removed, [...keptBefore, ...kept]);
    chats.put(row);
  };
  const cur = t.objectStore("messages").index("byChat").openCursor(IDBKeyRange.bound([chatId, from ?? -Infinity], [chatId, floor], false, true));
  cur.onsuccess = () => {
    const d = cur.result;
    if (!d) {
      finish();
      return;
    }
    const m = d.value;
    if (seen++ === chunk) {
      next = m.sort;
      finish();
      return;
    }
    if (prot.keys.has(m.key) || m.id != null && prot.ids.has(m.id))
      kept.push(m.sort);
    else {
      for (const term of termsOf(m))
        terms.delete([term, m.chatId, m.sort]);
      removed.push({ key: m.key, id: m.id, sort: m.sort, media: !!m.tab || tabsOf(m).length > 0, ...m.threadId != null ? { threadId: m.threadId } : {} });
      d.delete();
    }
    d.continue();
  };
  await done(t);
  return { removed, kept, next };
}
function trimRanges(ranges, floor, removed, kept) {
  const out = [];
  for (const [a, b] of ranges) {
    const cut = removed.filter((s) => a <= s && s <= b);
    if (!cut.length) {
      out.push([a, b]);
      continue;
    }
    const pts = [...cut.map((s) => [s, false]), ...kept.filter((s) => a <= s && s <= b).map((s) => [s, true])];
    if (floor <= b)
      pts.push([Math.max(floor, a), true]);
    pts.sort((x, y) => x[0] - y[0]);
    let run = null, before = false;
    for (const [s, keep] of pts) {
      if (keep) {
        if (run)
          run[1] = s;
        else
          run = [before ? s : a, s];
      } else {
        if (run) {
          out.push(run);
          run = null;
        }
        before = true;
      }
    }
    if (run) {
      run[1] = b;
      out.push(run);
    }
  }
  return out;
}
function narrow(chat, floor, removed, kept) {
  const was = chat.ranges;
  const sorts = removed.map((r) => r.sort).sort((x, y) => x - y);
  chat.ranges = trimRanges(was, floor, sorts, kept.slice().sort((x, y) => x - y));
  if (chat.historyStart && (!chat.ranges.length || !was.length || chat.ranges[0][0] !== was[0][0]))
    delete chat.historyStart;
  const live = chat.ranges[chat.ranges.length - 1];
  if (chat.seed != null && (!live || live[0] > chat.seed))
    delete chat.seed;
  if (removed.some((r) => r.media))
    delete chat.mediaDone;
  if (removed.length)
    delete chat.savedViews;
  if (chat.threads)
    for (const [k, t] of Object.entries(chat.threads)) {
      const cut = removed.filter((r) => r.threadId === Number(k)).map((r) => r.sort).sort((x, y) => x - y);
      if (!cut.length)
        continue;
      const before = t.ranges;
      t.ranges = trimRanges(before, floor, cut, kept.slice().sort((x, y) => x - y));
      if (t.historyStart && (!t.ranges.length || !before.length || t.ranges[0][0] !== before[0][0]))
        delete t.historyStart;
      const tl = t.ranges[t.ranges.length - 1];
      if (t.seed != null && (!tl || tl[0] > t.seed))
        delete t.seed;
      if (!t.ranges.length)
        delete chat.threads[Number(k)];
    }
}
function applyTrim(store, chat, floor, removed, kept) {
  if (!removed.length)
    return;
  store.dropMessages(chat.id, removed);
  narrow(chat, floor, removed, kept);
  store.saveChat(chat);
}
var pause = () => new Promise((r) => setTimeout(r, 0));
async function evict(store, db, keepNow, limits = EVICT_LIMITS, opts = {}) {
  const stats = { messages: 0, users: 0, members: 0, lists: 0 };
  const closed = opts.closed ?? (() => false), chunk = opts.chunk ?? EVICT_CHUNK;
  await store.flush();
  const counts = await countAll(db, [...store.chats.keys()]);
  const start = keepNow();
  const target = new Map;
  let total = 0;
  for (const [id, n] of counts) {
    const k = Math.min(n, limits.perChat);
    target.set(id, k);
    total += k;
  }
  if (total > limits.total) {
    const stale = [...store.chats.values()].filter((c) => !start.windows.has(c.id) && (target.get(c.id) ?? 0) > limits.stale).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || (a.lastAt < b.lastAt ? -1 : a.lastAt > b.lastAt ? 1 : a.id - b.id));
    for (const c of stale) {
      if (total <= limits.total)
        break;
      total -= target.get(c.id) - limits.stale;
      target.set(c.id, limits.stale);
    }
  }
  for (const [id, n] of counts) {
    if (closed())
      return stats;
    const k = target.get(id);
    if (n <= k || !store.chats.has(id))
      continue;
    const floor = await floorOf(db, id, k);
    if (floor == null)
      continue;
    const keptAll = [];
    for (let from = null;; ) {
      if (closed())
        return stats;
      const keep = keepNow(), chat = store.chats.get(id);
      if (!chat || keep.busy.has(id) || keep.windows.has(id) && k < Math.min(n, limits.perChat))
        break;
      const prot = { keys: new Set(keep.windows.get(id) ?? []), ids: new Set(chat.pinned ?? []) };
      if (chat.last)
        prot.keys.add(chat.last.key);
      const gen = store.resetGen;
      store.trimming.add(id);
      let r;
      try {
        r = await trimChunk(db, id, from, floor, chunk, prot, keptAll);
        const now = store.chats.get(id);
        if (!now || gen !== store.resetGen)
          break;
        keptAll.push(...r.kept);
        applyTrim(store, now, r.next ?? floor, r.removed, keptAll);
      } finally {
        store.trimming.delete(id);
      }
      stats.messages += r.removed.length;
      opts.onChunk?.(id, r.removed.length);
      await pause();
      if (r.next == null)
        break;
      from = r.next;
    }
  }
  if (closed())
    return stats;
  const keep = keepNow();
  for (const c of store.chats.values()) {
    if (!c.group || keep.members.has(c.id))
      continue;
    const n = store.members.list(c.id).length;
    if (n <= MEMBERS_PART || c.membersDone !== false && n <= MEMBERS_FULL && (c.group.members ?? 0) <= MEMBERS_FULL)
      continue;
    stats.members += store.members.trim(c.id, MEMBERS_PART);
    if (c.membersDone !== false) {
      c.membersDone = false;
      store.saveChat(c);
    }
    store.members.touched.add(c.id);
  }
  if (store.users.rows.size > limits.people) {
    await store.flush();
    const refs = new Set(keep.people);
    refs.add(store.userId);
    const note = (m) => {
      if (!m)
        return;
      refs.add(m.senderId);
      if (m.fwdFrom?.userId != null)
        refs.add(m.fwdFrom.userId);
      for (const r of m.reactions ?? [])
        refs.add(r.userId);
      for (const u of m.service?.data?.users ?? [])
        refs.add(u.id);
      for (const c of m.todo?.completions ?? [])
        refs.add(c.by);
    };
    for (const c of store.chats.values()) {
      if (c.peerId != null)
        refs.add(c.peerId);
      note(c.last);
      note(c.snapLast);
    }
    for (const r of store.members.table.rows.values())
      refs.add(r.userId);
    for (const id of store.contacts.table.rows.keys())
      refs.add(id);
    for (const id of store.blocks.table.rows.keys())
      refs.add(id);
    for (const q of store.quotes.values())
      refs.add(q.senderId);
    const t = db.transaction("messages"), cur = t.objectStore("messages").openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c)
        return;
      note(c.value);
      c.continue();
    };
    await done(t);
    for (const id of [...store.users.rows.keys()]) {
      if (refs.has(id))
        continue;
      store.users.delete(id);
      store.profileLists.dropUser(id);
      opts.onUserEvicted?.(id);
      stats.users++;
    }
  }
  stats.lists = store.profileLists.cap(PROFILE_LIST_MAX);
  if (!closed())
    await store.flush();
  return stats;
}

// packages/sync-engine/src/search.ts
var prefix = (w) => IDBKeyRange.bound([w, -Infinity, -Infinity], [w + "￿", Infinity, Infinity]);
var CHUNK = 64;
var TERMS_CAP = 2000;
function countUpTo(store, range, cap) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const cur = store.openKeyCursor(range);
    cur.onsuccess = () => {
      if (!cur.result || ++n >= cap)
        resolve(n);
      else
        cur.result.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}
async function searchLocal(db, q, o, loaded) {
  const words = searchTerms(q);
  if (!words.length)
    return { list: [], hasMore: false };
  const cap = o.cap ?? TERMS_CAP;
  const terms = db.transaction("terms").objectStore("terms");
  const counts = await Promise.all(words.map((w) => countUpTo(terms, prefix(w), cap)));
  if (counts.some((n) => n === 0))
    return { list: [], hasMore: false };
  const least = Math.min(...counts);
  const rare = words[counts.indexOf(least)];
  const capped = least >= cap;
  const rows = await req(db.transaction("terms").objectStore("terms").getAll(prefix(rare), cap));
  const seen = new Set;
  const cand = [];
  for (const r of rows) {
    if (o.chatId != null && r.chatId !== o.chatId)
      continue;
    if (o.beforeId != null && r.sort >= o.beforeId)
      continue;
    if (seen.has(r.key))
      continue;
    seen.add(r.key);
    cand.push(r);
  }
  cand.sort((x, y) => y.sort - x.sort);
  const fits = (m) => {
    if (!m || m.id == null || m.deleted)
      return false;
    const own = termsOf(m);
    return words.every((w) => own.some((t) => t.startsWith(w)));
  };
  const list = [];
  for (let i = 0;i < cand.length && list.length <= o.limit; i += CHUNK) {
    const part = cand.slice(i, i + CHUNK);
    const mem = part.map((r) => loaded(r.chatId, r.key));
    const missing = part.filter((_, j) => !mem[j]);
    const fromDb = new Map;
    if (missing.length) {
      const store = db.transaction("messages").objectStore("messages");
      const got = await Promise.all(missing.map((r) => req(store.get(r.key))));
      missing.forEach((r, j) => fromDb.set(r.key, got[j]));
    }
    for (let j = 0;j < part.length && list.length <= o.limit; j++) {
      const m = mem[j] ?? fromDb.get(part[j].key);
      if (fits(m))
        list.push(m);
    }
  }
  return { list: list.slice(0, o.limit), hasMore: capped || list.length > o.limit };
}

// packages/sync-engine/src/engine.ts
var OP_SCHEDULED = "scheduled:";
var HISTORY_GATE_MS = 400;
var HISTORY_AHEAD = 2;
var UPLOAD_SLOTS = 3;
var USERS_BATCH = 200;
function patchedChats(items, after) {
  const out = new Set;
  for (const { seq, update: u } of items) {
    if (seq > after && (u.type === "messageEdited" || u.type === "messageDeleted" || u.type === "reactions" || u.type === "reactionCounts" || u.type === "mediaListened" || u.type === "attachmentUpdated"))
      out.add(u.chatId);
  }
  return out;
}
var SEARCH_MEMO_MS = 300;

class Engine {
  cfg;
  store;
  db;
  transport;
  watchers = new Map;
  nextWatch = 1;
  frameTimer = null;
  readTimer = null;
  online = false;
  wantOnline = false;
  failures = 0;
  netDown = typeof navigator !== "undefined" && navigator.onLine === false;
  ready = false;
  syncing = false;
  holding = false;
  presence = new Map;
  presenceFetched = false;
  presenceTries = new Map;
  presenceRetry = null;
  peersRefreshed = false;
  presenceDirty = false;
  acting = 0;
  syncAgain = false;
  syncWaiter = null;
  reqSeq = 0;
  pending = new Map;
  pumping = false;
  uploads = new Map;
  memBlobs = new Map;
  busy = 0;
  historyLoads = new Map;
  chatLoads = new Map;
  watched = new Set;
  lastCreated = 0;
  closed = false;
  statusSig = "";
  refreshing = false;
  moreChats = null;
  typingTimers = new Map;
  ops;
  contacts;
  blocks;
  sessions;
  stickers;
  gifs;
  channelPosts;
  session;
  userWants = new Set;
  peerSigs = new PeerSigs;
  muteShown = new Map;
  autoDeleteShown = new Map;
  flagsShown = new Map;
  usersAsked = new Set;
  membersWants = new Set;
  membersAsked = new Set;
  media;
  views;
  lists;
  dev;
  constructor(cfg, store, db, ops, sim = null) {
    this.cfg = cfg;
    this.store = store;
    this.db = db;
    this.dev = new DevTools(db, {
      view: () => ({
        userId: cfg.userId,
        epoch: this.store.epoch,
        lastSeq: this.store.lastSeq,
        phase: this.phase(),
        ready: this.ready,
        syncing: this.syncing,
        socket: this.transport.view(),
        outbox: this.store.outbox.values(),
        pendingReads: this.store.pendingReads.size,
        ops: { pending: this.ops.list.length, keys: [...new Set(this.ops.list.map((o) => o.key))], failures: this.ops.failures.length },
        watchers: this.watchers.values()
      }),
      schedule: () => this.schedule(),
      ping: () => {
        if (this.online)
          this.transport.send({ op: "ping" });
      },
      offline: (on) => this.simOffline(on),
      dropSocket: () => this.transport.drop(),
      sync: () => {
        if (this.online && this.ready)
          this.runSync();
      },
      resync: () => this.resync(),
      restart: async () => {
        this.transport.stop();
        if (this.wantOnline)
          this.transport.start();
        return { restarted: "reconnect" };
      },
      retryFailed: () => this.retryFailed(),
      discardFailed: () => this.discardFailed(),
      wrapFetch: (f) => deviceFetch(f, cfg.httpBase)
    });
    this.dev.restore(sim);
    if (this.dev.sim.offline)
      this.netDown = true;
    store.onFlush = (keys, ms) => {
      this.dev.log.record("engine", "flush", { keys }, undefined, ms);
      this.scheduleEvict();
    };
    store.onExpiry = (at) => this.armExpiry(at);
    this.autoDeleteShown = autoDeleteOverlay(ops);
    this.muteShown = muteOverlay(ops);
    store.scheduledBusy = (clientId) => this.ops.list.some((o) => o.key === OP_SCHEDULED + clientId);
    this.ops = new Ops(db, ops, { base: cfg.httpBase, headers: cfg.headers, backoffMs: cfg.backoffMs, fetch: this.dev.fetch }, {
      canSend: () => this.online && this.ready && !this.closed && !this.resetting,
      done: (op, value) => this.opDone(op, value),
      changed: () => this.changed(),
      run: (fn) => this.run(fn),
      unauthorized: () => this.session.end("terminated"),
      log: (type, data) => {
        this.dev.log.record("engine", type, data);
        if (type === "opFail" && String(data.key).startsWith(OP_SCHEDULED))
          this.refreshScheduled();
        if (type === "opFail" && String(data.key).startsWith(OP_GIF))
          this.gifs.opFailed(String(data.key));
      }
    });
    this.contacts = new Contacts({
      store,
      ops: this.ops,
      httpBase: cfg.httpBase,
      headers: cfg.headers,
      fetch: this.dev.fetch,
      online: () => this.online,
      presence: () => this.presence,
      seedPresence: (id, p) => this.seedPresence(id, p),
      refreshUser: (id) => {
        this.usersAsked.delete(id);
        this.userWants.add(id);
      },
      http: (path) => this.http(path),
      run: (fn) => this.run(fn),
      changed: () => this.changed()
    });
    this.blocks = new Blocks({ store, ops: this.ops, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.views = new ViewCounter({
      online: () => this.online && this.ready,
      run: (fn) => this.run(fn),
      everyMs: cfg.viewsFlushMs ?? 1000,
      post: (chatId, ids) => this.http(`/chats/${chatId}/views`, { method: "POST", body: JSON.stringify({ ids }) }),
      apply: (chatId, views) => this.run(async () => {
        this.store.applyViews(chatId, views);
        this.changed();
      })
    });
    this.media = new MediaLoader(store, { online: () => this.online && this.ready, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.lists = new ProfileListsLoader(store, { online: () => this.online && this.ready, http: (path) => this.http(path), run: (fn) => this.run(fn), changed: () => this.changed() });
    this.sessions = new Sessions2({ ops: this.ops, online: () => this.online, http: (path) => this.http(path) });
    this.stickers = new Stickers({
      db,
      online: () => this.online,
      http: (path) => this.http(path),
      enqueue: (op) => this.ops.enqueue(op),
      bump: () => {
        this.store.stickersRev++;
        this.changed();
      },
      unsentStickers: () => [...this.store.outbox.values()].flatMap((o) => o.sticker && !o.failed ? [{ sticker: o.sticker, at: o.createdAt }] : [])
    });
    this.gifs = new SavedGifs({ db, online: () => this.online, http: (path, init) => this.http(path, init), enqueue: (op) => this.ops.enqueue(op), pending: (key) => this.ops.list.some((o) => o.key === key), run: (fn) => this.run(fn), rev: () => this.store.gifsRev, bump: () => {
      this.store.gifsRev++;
      this.changed();
    } });
    this.channelPosts = new ChannelPosts({
      db,
      online: () => this.online && this.ready,
      fetch: (path) => this.dev.fetch(this.cfg.httpBase + path, { credentials: "include", headers: this.cfg.headers })
    });
    this.session = new SessionEnd({
      httpBase: cfg.httpBase,
      headers: cfg.headers,
      fetch: this.dev.fetch,
      closed: () => this.closed,
      stop: () => {
        this.dev.log.record("engine", "sessionEnd", { reason: this.session.reason });
        this.ops.close();
        this.wantOnline = false;
        this.transport.stop();
      },
      notify: () => this.pushStatus(),
      working: () => this.syncing || this.pumping || this.busy > 1,
      run: (fn) => this.run(fn),
      shutdown: () => {
        if (this.closed)
          return false;
        this.emit();
        this.closed = true;
        this.dead = true;
        this.dev.stop();
        if (this.frameTimer) {
          clearTimeout(this.frameTimer);
          this.frameTimer = null;
        }
        if (this.readTimer) {
          clearTimeout(this.readTimer);
          this.readTimer = null;
        }
        if (this.outboxTimer) {
          clearTimeout(this.outboxTimer);
          this.outboxTimer = null;
        }
        if (this.evictTimer) {
          clearTimeout(this.evictTimer);
          this.evictTimer = null;
        }
        if (this.expiryTimer) {
          clearTimeout(this.expiryTimer);
          this.expiryTimer = null;
        }
        for (const t of this.typingTimers.values())
          clearTimeout(t);
        this.typingTimers.clear();
        this.views.close();
        this.watchers.clear();
        return true;
      },
      wipe: async () => {
        await this.store.wipe(null).catch(() => {});
        this.db.close();
        try {
          indexedDB.deleteDatabase(cfg.dbName);
        } catch {}
      }
    });
    store.contactOf = (id) => this.contacts.view().get(id);
    store.wantUser = (id) => this.userWants.add(id);
    store.refreshUser = (id) => {
      this.usersAsked.delete(id);
      this.userWants.add(id);
    };
    store.wantRow = (chatId) => this.refreshRows([chatId]);
    store.wantPost = (chatId, id) => {
      if (this.postsNoReplies.has(chatId + ":" + id))
        return;
      let s = this.postWants.get(chatId);
      if (!s) {
        s = new Set;
        this.postWants.set(chatId, s);
      }
      s.add(id);
    };
    this.transport = new WsTransport(cfg.wsUrl, {
      onOpen: () => this.onOpen(),
      onFrame: (f) => this.onFrame(f),
      onClose: () => this.onClose()
    }, cfg.backoffMs ?? [250, 5000], this.dev);
  }
  static async open(cfg) {
    let engine = null;
    const db = await openDb(cfg.dbName, { onVersionChange: () => engine?.obsolete() });
    const store = await Store.open(db, cfg.userId);
    engine = new Engine(cfg, store, db, await loadOps(db), await loadSim(db));
    await engine.startExpiry();
    return engine;
  }
  expiryTimer = null;
  expiryAt = Infinity;
  armExpiry(at) {
    if (this.closed || this.expiryTimer && at >= this.expiryAt)
      return;
    if (this.expiryTimer)
      clearTimeout(this.expiryTimer);
    this.expiryAt = at;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expiryAt = Infinity;
      this.sweepExpiry();
    }, Math.min(Math.max(0, at - this.store.serverNow()), 2 ** 31 - 1));
  }
  async sweepNow() {
    await this.store.flush();
    if (await this.store.sweepExpired()) {
      await this.store.flush();
      this.changed();
    }
    const next = await this.store.nextExpiry();
    if (next != null)
      this.armExpiry(Math.max(next, this.store.serverNow() + (next <= this.store.serverNow() ? 1000 : 0)));
  }
  sweepExpiry() {
    this.run(() => this.sweepNow());
  }
  async startExpiry() {
    await this.sweepNow();
  }
  dead = false;
  onObsoleteCb = () => {};
  onObsolete(cb) {
    this.onObsoleteCb = cb;
  }
  obsolete() {
    if (this.dead)
      return;
    this.dead = true;
    this.closed = true;
    this.ops.close();
    this.disconnect();
    this.dev.stop();
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
      this.evictTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.watchers.clear();
    this.onObsoleteCb();
  }
  callCbs = new Set;
  onCall(cb) {
    this.callCbs.add(cb);
    return () => this.callCbs.delete(cb);
  }
  callEvent(f) {
    for (const cb of this.callCbs)
      cb(f);
  }
  onTerminated(cb) {
    this.session.onDone(cb);
  }
  connect() {
    if (this.closed || this.session.ended)
      return;
    this.wantOnline = true;
    this.watchNetwork();
    this.transport.start();
    if (!this.safetyTimer)
      this.safetyTimer = setInterval(() => {
        if (!this.online || !this.ready || this.syncing)
          return;
        this.runSync();
        this.transport.send({ op: "chatsSince", since: this.store.since });
      }, this.cfg.safetySyncMs ?? 90000);
  }
  safetyTimer = null;
  chatSync = new Map;
  chatWaiters = new Map;
  chatQueue = [];
  chatActive = 0;
  refreshIds = new Set;
  refreshTimer = null;
  rowsInFlight = false;
  unknownAsked = new Map;
  sinceCandidate = null;
  disconnect() {
    this.wantOnline = false;
    this.transport.stop();
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    this.changed();
  }
  watchNetwork() {
    const g = globalThis;
    if (typeof g.addEventListener !== "function" || this.netWatched)
      return;
    this.netWatched = true;
    g.addEventListener("offline", () => {
      this.netDown = true;
      this.changed();
    });
    g.addEventListener("online", () => {
      this.netDown = this.dev.sim.offline;
      this.changed();
      this.transport.retryNow();
    });
  }
  netWatched = false;
  phase() {
    if (!this.online)
      return this.wantOnline && !this.netDown && this.failures < 2 ? "connecting" : "offline";
    if (this.ready)
      return "ready";
    return this.store.hydrated ? "updating" : "loading";
  }
  async close() {
    if (this.dead)
      return;
    this.closed = true;
    this.ops.close();
    this.disconnect();
    this.dev.stop();
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.evictTimer) {
      clearTimeout(this.evictTimer);
      this.evictTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.watchers.clear();
    await this.whenIdle(2000).catch((e) => console.warn(String(e)));
    await this.evicting?.catch(() => {});
    await this.store.flush();
    this.db.close();
  }
  watch(q, cb) {
    const w = { id: this.nextWatch++, q, cb, prev: null, force: true, gated: q.kind === "messages" || q.kind === "thread" || q.kind === "savedFeed" };
    this.watchers.set(w.id, w);
    if (q.kind === "messages")
      this.store.noteOpened(q.chatId);
    if (q.kind === "devStats" || q.kind === "devLog")
      this.dev.track(this.watchers.values());
    this.prepare(w);
    this.schedule();
    return {
      update: (q2) => {
        const chatChanged = q2.kind === "messages" && (w.q.kind !== "messages" || w.q.chatId !== q2.chatId);
        if (chatChanged)
          this.store.noteOpened(q2.chatId);
        w.q = q2;
        w.force = true;
        if (chatChanged)
          w.gated = true;
        this.dev.track(this.watchers.values());
        this.prepare(w);
        this.schedule();
      },
      close: () => {
        this.watchers.delete(w.id);
        this.dev.track(this.watchers.values());
        if (w.q.kind === "thread")
          this.syncThreadWatches();
      }
    };
  }
  prepare(w) {
    if (w.q.kind === "user" && w.q.userId !== this.cfg.userId) {
      this.usersAsked.delete(w.q.userId);
      this.userWants.add(w.q.userId);
      return;
    }
    if (w.q.kind === "members") {
      this.membersWants.add(w.q.chatId);
      this.fetchMembers();
      return;
    }
    if (w.q.kind === "media") {
      this.media.want(w.q);
      return;
    }
    if (w.q.kind === "profileMusic" || w.q.kind === "profilePhotos") {
      this.lists.want(w.q);
      return;
    }
    if (w.q.kind === "thread") {
      this.prepareThread(w);
      return;
    }
    if (w.q.kind === "savedFeed") {
      this.prepareSaved(w);
      return;
    }
    if (w.q.kind === "savedDialogs") {
      if (!this.store.savedDialogs.meta.loaded)
        this.refreshSavedDialogs();
      return;
    }
    if (w.q.kind !== "messages")
      return;
    const { chatId, limit } = w.q;
    const q = w.q;
    const open = () => {
      if (w.q === q && w.gated) {
        w.gated = false;
        this.changed();
      }
    };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(chatId);
        const history = this.ensureOpenChat(chatId).catch(() => {}).then(() => this.ensureWindow(q));
        if (this.online && w.gated)
          await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }
  prepareThread(w) {
    const q = w.q;
    const open = () => {
      if (w.q === q && w.gated) {
        w.gated = false;
        this.changed();
      }
    };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(q.chatId);
        const history = this.ensureThreadWindow(q);
        if (this.online && w.gated)
          await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }
  prepareSaved(w) {
    const q = w.q;
    const open = () => {
      if (w.q === q && w.gated) {
        w.gated = false;
        this.changed();
      }
    };
    this.run(async () => {
      try {
        await this.store.loadChatMessages(q.chatId);
        const history = this.ensureSavedWindow(q);
        if (this.online && w.gated)
          await Promise.race([history.catch(() => {}), new Promise((r) => setTimeout(r, HISTORY_GATE_MS))]);
        open();
        await history;
      } finally {
        open();
      }
    });
  }
  async ensureSavedWindow(q) {
    const page = this.cfg.historyPage ?? 50;
    for (let guard = 0;guard < 50; guard++) {
      if (!this.online || !this.store.chats.has(q.chatId))
        return;
      const { all, lo, hi, floor } = savedView(this.store, q);
      if (floor === true)
        return;
      const { from, to } = savedView(this.store, q);
      const short = !q.anchor ? hi - lo < q.limit : !(hi > lo && all[lo].sort <= q.anchor.sort) || q.anchor.side !== "start" && from === lo && to - from < q.limit;
      if (!short)
        return;
      if (!await this.loadSavedPage(q.chatId, q.peer) && savedView(this.store, q).floor !== true)
        return;
    }
  }
  loadSavedPage(chatId, peer) {
    const k = chatId + ":" + peer, running = this.savedLoads.get(k);
    if (running)
      return running.then(() => 0);
    const floor = savedView(this.store, { kind: "savedFeed", chatId, peer, limit: 1 }).floor;
    if (floor === true)
      return Promise.resolve(0);
    const page = this.cfg.historyPage ?? 50, gen = this.store.resetGen, trims = this.store.trimGen(chatId);
    const p = (async () => {
      const res = await this.http(`/chats/${chatId}/messages?limit=${page}&savedPeer=${encodeURIComponent(peer)}${Number.isFinite(floor) ? `&before=${floor}` : ""}`);
      const c = this.store.chats.get(chatId);
      if (!c || gen !== this.store.resetGen)
        return 0;
      this.store.addLoose(chatId, res.messages);
      if (trims === this.store.trimGen(chatId)) {
        let lo = floor;
        for (const m of res.messages)
          if (m.id < lo)
            lo = m.id;
        const views = c.savedViews ??= {};
        views[peer] = { ...views[peer], floor: res.hasMore && res.messages.length ? lo : true };
        this.store.markChat(c);
      }
      await this.store.flush();
      this.changed();
      return res.messages.length;
    })().finally(() => this.savedLoads.delete(k));
    this.savedLoads.set(k, p);
    return p;
  }
  savedLoads = new Map;
  refreshSavedDialogs(next = false) {
    if (this.savedLoading) {
      if (!next)
        this.savedAgain = true;
      return this.savedLoading;
    }
    const chat = savedChatOf(this.store);
    if (!chat || !this.online || !this.ready)
      return Promise.resolve();
    const cache = this.store.savedDialogs, rev = cache.rev, at = next ? cache.meta.next : null;
    if (next && at == null)
      return Promise.resolve();
    cache.want = false;
    const p = (async () => {
      const page = await this.http(`/chats/${chat.id}/saved-dialogs${at != null ? "?before=" + at : ""}`);
      if (rev !== cache.rev) {
        this.savedAgain = true;
        return;
      }
      await this.store.loadChatMessages(chat.id);
      applySavedPage(this.store, chat.id, page, at);
      await this.store.flush();
      this.changed();
    })().finally(() => {
      this.savedLoading = null;
      if (this.savedAgain) {
        this.savedAgain = false;
        this.run(() => this.refreshSavedDialogs());
      }
    });
    this.savedLoading = p;
    return p;
  }
  savedLoading = null;
  savedAgain = false;
  changed() {
    this.handleSeqHints();
    this.syncThreadWatches();
    this.pushStatus();
    this.schedule();
  }
  pushStatus() {
    if (this.closed)
      return;
    const sig = JSON.stringify(this.statusItem());
    if (sig === this.statusSig)
      return;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      if (w.q.kind !== "status" || w.force)
        continue;
      const next = this.compute(w.q);
      const patch = diffResults(w.prev, next);
      w.prev = next;
      if (patch) {
        try {
          w.cb(patch);
        } catch (err) {
          console.error("watch callback failed", err);
          this.dev.log.error("watch callback", err);
        }
      }
    }
  }
  status() {
    return this.statusItem();
  }
  statusItem() {
    return {
      key: "status",
      phase: this.phase(),
      hydrated: this.store.hydrated,
      chatsComplete: this.store.dialogsDone,
      chatsTotal: this.store.dialogsTotal,
      chatsCursorAt: this.store.dialogsAt,
      online: this.online,
      synced: this.ready,
      syncing: this.syncing,
      outbox: [...this.store.outbox.values()].filter((o) => !o.failed).length,
      failed: [...this.store.outbox.values()].filter((o) => o.failed).length,
      ...this.session.status(),
      sessionsRev: this.store.sessionsRev,
      clockSkew: this.store.clockSkew,
      expiredFiles: [...this.store.expiredFiles].filter((id) => !this.gifs.has(id)),
      gifsRev: this.store.gifsRev,
      stickersRev: this.store.stickersRev,
      devSim: simFlags(this.dev.sim)
    };
  }
  compute(q) {
    if (q.kind === "presence") {
      const p = this.presence.get(q.userId);
      const it = { key: "p" + q.userId, userId: q.userId, known: !!p, online: p?.online ?? false, lastSeen: p?.lastSeen ?? null };
      return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
    }
    if (q.kind === "contacts") {
      const list = this.contacts.items();
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === "blocked") {
      const list = this.blocks.items();
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === "settings") {
      const s = this.store.settings, view = settingsView(s.base, this.ops.list);
      const list = settingsItem(view, s.loaded, view !== s.base);
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === "me" || q.kind === "user" || q.kind === "ops") {
      const list = q.kind === "ops" ? [this.ops.item()] : q.kind === "me" ? meItem(this.meNow()) : userItem(this.store.profile, this.meNow(), q.userId);
      if (q.kind === "user" && !list.length && q.userId !== this.cfg.userId)
        this.userWants.add(q.userId);
      return { items: new Map(list.map((it) => [it.key, it])), order: list.map((it) => it.key), sig: new Map(list.map((it) => [it.key, JSON.stringify(it)])) };
    }
    if (q.kind === "scheduled")
      return scheduledResult(this.store, q.chatId);
    if (q.kind === "members")
      return membersResult(this.store, q.chatId, this.presence, this.meNow());
    if (q.kind === "media")
      return mediaResult(this.store, q, this.media.loading(q.chatId, q.tab, q.savedPeer));
    if (q.kind === "savedFeed")
      return savedFeedResult(this.store, q);
    if (q.kind === "savedDialogs")
      return savedDialogsResult(this.store, this.ops.list);
    if (q.kind === "profileMusic")
      return profileMusicResult(this.store, q.userId, this.ops.list, this.lists.loading(q));
    if (q.kind === "profilePhotos")
      return profilePhotosResult(this.store, q.userId, this.meNow(), this.lists.loading(q));
    if (q.kind === "people")
      return peopleResult(this.store, q.ids, q.ids.includes(this.cfg.userId) ? this.meNow() : null);
    if (q.kind === "devStats" || q.kind === "devLog") {
      const it = q.kind === "devStats" ? this.dev.stats() : { key: "devLog" };
      return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
    }
    if (q.kind !== "status")
      return computeQuery(this.store, q, muteOverlay(this.ops.list), flagsOverlay(this.ops.list), autoDeleteOverlay(this.ops.list));
    const it = this.statusItem();
    return { items: new Map([[it.key, it]]), order: [it.key], sig: new Map([[it.key, JSON.stringify(it)]]) };
  }
  schedule() {
    if (this.frameTimer || this.closed)
      return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.emit();
    }, this.cfg.frameMs ?? 16);
  }
  async upload(clientId, blob, a) {
    const offline = { code: "offline", retry: true };
    const api = async (path, body, method = "POST") => {
      const r = await this.dev.fetch(this.cfg.httpBase + path, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json", ...this.cfg.headers ?? {} },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).catch(() => {
        throw offline;
      });
      if (this.session.unauthorized(r.status))
        throw offline;
      if (!r.ok) {
        const code = (await r.json().catch(() => null))?.code ?? "upload";
        throw { code, retry: r.status >= 500 || code === "upload_missing" };
      }
      return r.json();
    };
    const meta = { name: a.name, mime: a.mime, size: blob.size };
    const encrypt = this.cfg.encryptFiles !== false;
    if (a.w && a.h) {
      meta.w = a.w;
      meta.h = a.h;
    }
    if (a.kind === "voice" || a.kind === "round" || a.kind === "audio" || a.kind === "video") {
      meta.kind = a.kind;
      if (a.duration)
        meta.duration = a.duration;
      if (a.waveform)
        meta.waveform = a.waveform;
    }
    if (a.kind === "audio") {
      if (a.title)
        meta.title = a.title;
      if (a.performer)
        meta.performer = a.performer;
    }
    let mp = this.store.outbox.get(clientId)?.upload ?? null;
    if (mp && encrypt && !mp.key) {
      await this.saveUpload(clientId, null);
      mp = null;
    }
    const keyRaw = mp?.key ? fromBase64(mp.key) : newFileKey();
    const base = mp?.base ? fromBase64(mp.base) : newNonceBase();
    const source = encrypt ? sealedSource(blob, await importFileKey(keyRaw), { chunk: FILE_CHUNK, size: blob.size, base }) : blob;
    if (encrypt) {
      meta.enc = 1;
      meta.key = toBase64(keyRaw);
    }
    if (!mp) {
      const intent = await api("/uploads", meta);
      if (!intent.multipart) {
        await this.put(clientId, intent.url, await source.slice(0, source.size), intent.mime);
        return api(`/uploads/${intent.id}/confirm`);
      }
      mp = { id: intent.id, ...intent.multipart, done: [], ...encrypt ? { key: toBase64(keyRaw), base: toBase64(base) } : {} };
      await this.saveUpload(clientId, mp);
    }
    return this.uploadMultipart(clientId, source, mp, api);
  }
  async uploadMultipart(clientId, blob, mp, api) {
    let last = 0, pending = null, latest = 0;
    const show = () => {
      pending = null;
      last = Date.now();
      this.store.setProgress(clientId, 0.98 * latest);
      this.changed();
    };
    const io = {
      urls: async (parts) => (await api(`/uploads/${mp.id}/parts`, { parts })).urls,
      saved: (done) => this.saveUpload(clientId, { ...mp, done }),
      progress: (p) => {
        latest = p;
        if (pending)
          return;
        const wait = 100 - (Date.now() - last);
        if (wait <= 0)
          show();
        else
          pending = setTimeout(show, wait);
      },
      register: (ctl) => this.uploads.set(clientId, ctl),
      cancelled: () => this.cancelled.has(clientId) || !this.store.outbox.has(clientId),
      offline: () => this.dev.sim.offline
    };
    try {
      for (let round = 0;; round++) {
        if (io.cancelled())
          throw { code: "cancelled", retry: false };
        await uploadParts(blob, mp, io);
        try {
          return await api(`/uploads/${mp.id}/confirm`);
        } catch (e) {
          if (e.code !== "upload_incomplete" || round > 0)
            throw e;
          const st = await api(`/uploads/${mp.id}/parts`, undefined, "GET");
          mp = { ...mp, done: st.done };
          await this.saveUpload(clientId, mp);
        }
      }
    } catch (e) {
      const code = e.code;
      if (code === "not_found" || code === "upload_mismatch") {
        await this.saveUpload(clientId, null);
        if (code === "not_found")
          throw { code, retry: true };
      }
      if (code === "upload_incomplete")
        throw { code, retry: true };
      if (code === "offline" && this.online && !this.netDown)
        throw { code: "upload", retry: true };
      throw e;
    } finally {
      if (pending) {
        clearTimeout(pending);
        show();
      }
      this.uploads.delete(clientId);
    }
  }
  async saveUpload(clientId, mp) {
    if (!this.store.outbox.has(clientId))
      return;
    this.store.setUploadState(clientId, mp);
    await this.store.flush();
  }
  put(clientId, url, blob, mime) {
    const offline = { code: "offline", retry: true };
    const fail = (status) => ({ code: "upload", retry: status >= 500 || status === 403 || status === 408 || status === 429 });
    if (this.dev.sim.offline)
      return Promise.reject(offline);
    if (!this.store.outbox.has(clientId))
      return Promise.reject({ code: "cancelled", retry: false });
    if (typeof XMLHttpRequest === "undefined") {
      const ac = new AbortController;
      this.uploads.set(clientId, ac);
      return fetch(url, { method: "PUT", body: blob, headers: { "content-type": mime }, signal: ac.signal }).then((r) => {
        if (!r.ok)
          throw fail(r.status);
      }, () => {
        throw this.cancelled.has(clientId) ? { code: "cancelled", retry: false } : offline;
      }).finally(() => {
        if (this.uploads.get(clientId) === ac)
          this.uploads.delete(clientId);
      });
    }
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest;
      x.open("PUT", url);
      x.setRequestHeader("content-type", mime);
      let last = 0;
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable || e.timeStamp - last < 100)
          return;
        last = e.timeStamp;
        this.store.setProgress(clientId, 0.98 * e.loaded / e.total);
        this.changed();
      };
      const done = () => {
        if (this.uploads.get(clientId) === x)
          this.uploads.delete(clientId);
      };
      x.onload = () => {
        done();
        if (x.status < 300)
          resolve();
        else
          reject(fail(x.status));
      };
      x.onerror = () => {
        done();
        reject(offline);
      };
      x.onabort = () => {
        done();
        reject(this.cancelled.has(clientId) ? { code: "cancelled", retry: false } : offline);
      };
      this.uploads.set(clientId, x);
      x.send(blob);
    });
  }
  resetting = false;
  hellos = 0;
  skipped = { hello: null, poke: false };
  async storageStats() {
    const rows = await countStores(this.db);
    let bytes = null, exact = false;
    try {
      const e = await navigator.storage.estimate();
      exact = e.usageDetails?.indexedDB != null;
      bytes = e.usageDetails?.indexedDB ?? e.usage ?? null;
    } catch {}
    return { rows, bytes, exact };
  }
  async resetLocal(keepOutbox) {
    if (this.resetting)
      throw new Error("reset_busy");
    this.dev.log.record("engine", "resetLocal", { keepOutbox });
    this.resetting = true;
    let ok = false;
    try {
      const end = Date.now() + (this.cfg.resetWaitMs ?? 8000);
      for (const x of this.uploads.values())
        x.abort();
      while (this.syncing || this.pumping || this.ops.busy || this.busy > 0) {
        if (Date.now() > end)
          throw new Error("reset_busy");
        await new Promise((r) => setTimeout(r, 10));
      }
      await this.store.wipe(this.store.epoch, { outbox: keepOutbox });
      this.clearAllChatState();
      if (!keepOutbox)
        this.ops.forget();
      this.forgetAsked();
      this.ready = false;
      this.holding = false;
      this.emit();
      ok = true;
    } finally {
      this.resetting = false;
      const sk = this.skipped;
      this.skipped = { hello: null, poke: false };
      if (!ok) {
        if (sk.hello)
          this.onFrame(sk.hello);
        else if (sk.poke)
          this.runSync();
        this.ops.kick();
        this.changed();
      }
    }
    this.changed();
    this.transport.send({ op: "hello", lastSeq: 0, since: 0 });
  }
  async search(a) {
    const limit = a.limit ?? 30;
    const local = this.searchLocal(a, limit);
    if (a.local || !this.online)
      return local;
    let res;
    try {
      const qs = new URLSearchParams({ q: a.q, limit: String(limit) });
      if (a.chatId)
        qs.set("chatId", String(a.chatId));
      if (a.beforeId)
        qs.set("beforeId", String(a.beforeId));
      if (a.savedPeer)
        qs.set("savedPeer", a.savedPeer);
      res = await this.http(`/search?${qs}`);
    } catch {
      return local;
    }
    const mine = await local.catch(() => ({ hits: [], hasMore: false, source: "local" }));
    const seen = new Set(mine.hits.map((h) => h.chatId + ":" + h.id));
    const server = res.hits.filter(({ message: m }) => !seen.has(m.chatId + ":" + m.id)).map(({ message: m, chatTitle }) => ({ chatId: m.chatId, chatTitle: this.titleOfChat(m.chatId) ?? chatTitle ?? null, id: m.id, sort: m.id, senderId: m.senderId, body: m.body, createdAt: m.createdAt, kind: m.kind, attachment: m.attachment ?? null, entities: m.entities ?? null, ...m.service ? { service: m.service } : {}, source: "server" }));
    const all = [...mine.hits, ...server].sort((x, y) => y.id - x.id);
    return { hits: all.slice(0, limit), hasMore: all.length > limit || res.hasMore || mine.hasMore, source: "server" };
  }
  searchFailed(e) {
    if (this.session.ended)
      throw e;
  }
  async searchPeople(q) {
    if (this.online) {
      try {
        return (await this.http(`/search/people?${new URLSearchParams({ q })}`)).people;
      } catch (e) {
        this.searchFailed(e);
      }
    }
    this.searchFailed(new Error("session_ended"));
    return localPeople(this.store, this.contacts.view(), this.cfg.userId, q);
  }
  async searchMedia(kind, q, before) {
    if (!MEDIA_TABS.includes(kind))
      throw new Error("bad_frame");
    if (this.online) {
      try {
        return await this.http(`/search/media?${new URLSearchParams({ kind, q, ...before ? { before: String(before) } : {} })}`);
      } catch (e) {
        this.searchFailed(e);
      }
    }
    this.searchFailed(new Error("session_ended"));
    if (this.store.termsDirty)
      await this.store.flush();
    const { scanned: _s, ...r } = await localMedia(this.db, this.store, kind, q, before);
    return r;
  }
  async topChats() {
    if (this.online) {
      try {
        return (await this.http("/search/top")).chatIds;
      } catch (e) {
        this.searchFailed(e);
      }
    }
    this.searchFailed(new Error("session_ended"));
    return localTop(this.store);
  }
  searchLocal(a, limit) {
    const key = [a.q, a.chatId ?? "", a.savedPeer ?? "", a.beforeId ?? "", limit].join("\x00");
    let p = this.searchMemo.get(key);
    if (!p) {
      p = this.searchLocalNow(a, limit);
      this.searchMemo.set(key, p);
      const drop = () => setTimeout(() => {
        if (this.searchMemo.get(key) === p)
          this.searchMemo.delete(key);
      }, SEARCH_MEMO_MS);
      p.then(drop, drop);
    }
    return p;
  }
  searchMemo = new Map;
  async searchLocalNow(a, limit) {
    if (this.store.termsDirty)
      await this.store.flush();
    const { list: found, hasMore } = await searchLocal(this.db, a.q, { chatId: a.chatId, beforeId: a.beforeId, limit }, (c, k) => this.store.loadedMessage(c, k));
    const list = a.savedPeer ? found.filter((m) => m.savedPeer === a.savedPeer) : found;
    return {
      hits: list.map((m) => ({ chatId: m.chatId, chatTitle: this.titleOfChat(m.chatId), id: m.id, sort: m.sort, senderId: m.senderId, body: m.body, createdAt: m.createdAt, kind: m.kind, attachment: m.attachment ?? null, entities: m.entities ?? null, ...m.service ? { service: m.service } : {}, source: "local" })),
      hasMore,
      source: "local"
    };
  }
  async takeDraft(chatId) {
    const text = this.store.chats.get(chatId)?.draft?.text ?? "";
    if (this.store.setDraft(chatId, ""))
      this.store.pendingDrafts.add(chatId);
    return draftHash(text);
  }
  pushDrafts() {
    if (!this.online || !this.ready)
      return;
    const sending = new Set;
    for (const o of this.store.outbox.values())
      if (!o.failed && o.draftHash !== null)
        sending.add(o.chatId);
    for (const chatId of [...this.store.pendingDrafts]) {
      if (sending.has(chatId))
        continue;
      const draft = this.store.chats.get(chatId)?.draft ?? null;
      const text = draft?.text ?? "";
      this.run(async () => {
        await this.request({ op: "draft", reqId: "", chatId, text, entities: draft?.entities ?? [] });
        if ((this.store.chats.get(chatId)?.draft ?? null) === draft)
          this.store.pendingDrafts.delete(chatId);
      });
    }
  }
  fetchQuotes() {
    if (!this.online || !this.store.quoteWants.size)
      return;
    const wants = [...this.store.quoteWants.entries()];
    this.store.quoteWants.clear();
    for (const [chatId, ids] of wants) {
      this.run(async () => {
        const res = await this.http(`/chats/${chatId}/messages?ids=${[...ids].join(",")}`);
        await this.store.loadChatMessages(chatId);
        this.store.addQuotes(chatId, res.messages, [...ids]);
        this.changed();
      });
    }
  }
  titleOfChat(chatId) {
    const c = this.store.chats.get(chatId);
    return c ? chatTitle(this.store, c) : null;
  }
  retouchFlags() {
    const now = new Map([...flagsOverlay(this.ops.list)].map(([id, v]) => [id, JSON.stringify(v)]));
    for (const [id, v] of now)
      if (this.flagsShown.get(id) !== v)
        this.store.retouch(id);
    for (const id of this.flagsShown.keys())
      if (!now.has(id))
        this.store.retouch(id);
    this.flagsShown = now;
  }
  retouchMute() {
    const now = muteOverlay(this.ops.list);
    for (const [id, v] of now)
      if (!this.muteShown.has(id) || this.muteShown.get(id) !== v)
        this.store.retouch(id);
    for (const id of this.muteShown.keys())
      if (!now.has(id))
        this.store.retouch(id);
    this.muteShown = now;
  }
  retouchAutoDelete() {
    const now = autoDeleteOverlay(this.ops.list);
    for (const [id, v] of now)
      if (!this.autoDeleteShown.has(id) || this.autoDeleteShown.get(id) !== v)
        this.store.retouch(id);
    for (const id of this.autoDeleteShown.keys())
      if (!now.has(id))
        this.store.retouch(id);
    this.autoDeleteShown = now;
  }
  emit() {
    this.contacts.repair();
    if (this.store.profile.dirty || this.store.contacts.dirty || this.ops.dirty)
      this.peerSigs.retouch(this.store);
    if (this.ops.dirty) {
      this.retouchMute();
      this.retouchFlags();
      this.retouchAutoDelete();
    }
    const hold = this.holding && this.acting === 0;
    const touched = new Set(this.store.touched);
    if (!hold)
      this.store.touched.clear();
    const sig = JSON.stringify(this.statusItem());
    const statusChanged = sig !== this.statusSig;
    const presenceDirty = this.presenceDirty;
    this.presenceDirty = false;
    const opsDirty = this.ops.dirty, profileDirty = this.store.profile.dirty || opsDirty;
    this.ops.dirty = false;
    const contactsDirty = this.store.contacts.dirty || opsDirty || presenceDirty || profileDirty;
    const peopleDirty = this.store.contacts.dirty || profileDirty;
    const membersTouched = new Set(this.store.members.touched);
    this.store.members.touched.clear();
    const listsTouched = new Set(this.store.profileLists.touched);
    this.store.profileLists.touched.clear();
    this.store.contacts.dirty = false;
    const settingsDirty = this.store.settings.dirty || opsDirty;
    this.store.settings.dirty = false;
    const blocksDirty = this.store.blocks.dirty || opsDirty || profileDirty;
    this.store.blocks.dirty = false;
    const devDirty = this.dev.statsDue;
    this.store.profile.dirty = hold && profileDirty;
    this.statusSig = sig;
    for (const w of this.watchers.values()) {
      if (w.q.kind === "devLog") {
        this.dev.pushLog(w);
        continue;
      }
      const own = w.q.kind === "devStats" && devDirty || w.q.kind === "status" && statusChanged || w.q.kind === "presence" && presenceDirty || w.q.kind === "ops" && opsDirty || (w.q.kind === "me" || w.q.kind === "user") && profileDirty || w.q.kind === "people" && peopleDirty || w.q.kind === "savedDialogs" && (opsDirty || peopleDirty) || w.q.kind === "contacts" && contactsDirty || w.q.kind === "settings" && settingsDirty || w.q.kind === "blocked" && blocksDirty || w.q.kind === "members" && (membersTouched.has(w.q.chatId) || peopleDirty || presenceDirty) || w.q.kind === "profileMusic" && (listsTouched.has("m:" + w.q.userId) || opsDirty && w.q.userId === this.cfg.userId) || w.q.kind === "profilePhotos" && (listsTouched.has("p:" + w.q.userId) || profileDirty);
      if (!w.force && !affects(w.q, touched) && !own)
        continue;
      if (hold && !w.force && w.q.kind !== "status" && w.q.kind !== "presence" && w.q.kind !== "ops" && w.q.kind !== "contacts" && w.q.kind !== "people" && w.q.kind !== "settings" && w.q.kind !== "blocked" && w.q.kind !== "members" && w.q.kind !== "profileMusic" && w.q.kind !== "profilePhotos" && w.q.kind !== "devStats")
        continue;
      if (w.gated)
        continue;
      const forced = w.force;
      w.force = false;
      const next = this.compute(w.q);
      if (w.q.kind === "people")
        this.wantPeople(w.q.ids);
      const patch = diffResults(w.prev, next) ?? (forced ? { op: "diff", upsert: [], remove: [] } : null);
      w.prev = next;
      if (patch) {
        this.dev.patched(w, patch);
        try {
          w.cb(patch);
        } catch (err) {
          console.error("watch callback failed", err);
          this.dev.log.error("watch callback", err);
        }
      }
    }
    this.dev.afterEmit();
    this.askUnknownPresence();
    this.fetchQuotes();
    this.fetchPosts();
    this.fetchUsers();
    this.fetchMembers();
    for (const w of this.watchers.values()) {
      if (w.q.kind === "media")
        this.media.want(w.q);
      else if (w.q.kind === "profileMusic" || w.q.kind === "profilePhotos")
        this.lists.want(w.q);
    }
    if (this.store.savedDialogs.want && this.ready && this.online)
      this.run(() => this.refreshSavedDialogs());
  }
  seedPresence(id, p) {
    if (this.online && !this.presence.has(id)) {
      this.presence.set(id, p);
      this.presenceDirty = true;
    }
  }
  fetchMembers() {
    if (!this.online || !this.ready || !this.membersWants.size)
      return;
    for (const chatId of [...this.membersWants]) {
      const chat = this.store.chats.get(chatId);
      if (!chat?.group)
        continue;
      this.membersWants.delete(chatId);
      if (this.membersAsked.has(chatId))
        continue;
      this.membersAsked.add(chatId);
      const seq = this.store.lastSeq, chatAt = this.store.chatSeq.get(chatId) ?? 0;
      if (chat.membersDone === undefined)
        this.store.members.loading.add(chatId);
      this.run(async () => {
        let r;
        try {
          r = await this.http(`/chats/${chatId}/members`);
        } catch (err) {
          this.store.members.loading.delete(chatId);
          if (!this.online) {
            this.membersAsked.delete(chatId);
            this.membersWants.add(chatId);
          }
          throw err;
        }
        applyMembersReply(this.store, chatId, r, seq, chatAt);
        for (const m of r.members)
          if (m.userId !== this.cfg.userId)
            this.seedPresence(m.userId, { online: m.online, lastSeen: m.lastSeen });
        await this.store.flush();
        this.changed();
      });
    }
  }
  meNow() {
    return meView(this.store.profile.me, this.ops.list);
  }
  nameOf(userId) {
    if (userId === this.cfg.userId)
      return this.meNow()?.name ?? "";
    const u = this.store.profile.users.get(userId);
    if (u?.name)
      return u.name;
    return displayName(this.store, userId);
  }
  opDone(op, value) {
    if (op.key.startsWith(OP_GIF)) {
      this.gifs.opDone(op, value);
      return;
    }
    if (op.key.startsWith(OP_SCHEDULED)) {
      const clientId = op.key.slice(OP_SCHEDULED.length), v = value;
      if (v?.item)
        this.store.applyScheduled(v.item, true);
      else {
        const c = this.store.scheduled.get(clientId);
        if (c)
          this.store.removeScheduled(c.chatId, clientId);
      }
      this.run(() => this.store.flush());
      return;
    }
    if (this.contacts.opDone(op, value))
      return;
    if (this.blocks.opDone(op, value))
      return;
    if (this.lists.opDone(op, value))
      return;
    if (op.key.startsWith("flags:")) {
      const v = value;
      if (v && typeof v.archived === "boolean") {
        this.store.setFlags(Number(op.key.slice(6)), { pinnedAt: v.pinnedAt ?? null, archived: v.archived, unreadMark: !!v.unreadMark, archivedAtId: v.archivedAtId });
        this.run(() => this.store.flush());
      }
      return;
    }
    if (op.key.startsWith("unarchive:")) {
      const v = value;
      if (v && typeof v.archived === "boolean") {
        this.store.setFlags(Number(op.key.slice(10)), { pinnedAt: v.pinnedAt ?? null, archived: v.archived, unreadMark: !!v.unreadMark, archivedAtId: v.archivedAtId });
        this.run(() => this.store.flush());
      }
      return;
    }
    if (op.key.startsWith("autoDelete:")) {
      const v = value;
      if (v && v.autoDeleteSec !== undefined) {
        this.store.setAutoDelete(Number(op.key.slice(11)), v.autoDeleteSec);
        this.run(() => this.store.flush());
      }
      return;
    }
    if (op.key.startsWith("mute:")) {
      const v = value;
      if (v && v.muteUntil !== undefined) {
        this.store.setMute(Number(op.key.slice(5)), v.muteUntil);
        this.run(() => this.store.flush());
      }
      return;
    }
    if (isNotifyOp(op)) {
      const v = value;
      if (v?.notify && this.store.settings.apply({ notify: v.notify, sessionsTtlDays: v.sessionsTtlDays, folders: v.folders, privacy: v.privacy }, v.seq))
        this.run(() => this.store.flush());
      return;
    }
    if ((op.key === OP_PROFILE || op.key === OP_USERNAME || op.key === OP_LINKS || op.key === OP_PCHANNEL) && value && typeof value === "object" && value.userId === this.cfg.userId) {
      if (this.store.profile.setMe(value))
        this.run(() => this.store.flush());
    }
  }
  refreshScheduled() {
    this.run(async () => {
      for (let i = 0;i < 3; i++) {
        const rev = this.store.scheduledRev;
        const r = await this.http("/chats/scheduled").catch(() => null);
        if (!r)
          return;
        if (rev !== this.store.scheduledRev)
          continue;
        this.store.replaceScheduled(r.items);
        await this.store.flush();
        this.changed();
        return;
      }
    });
  }
  fetchSettings() {
    this.run(async () => {
      const r = await this.http("/settings");
      if (!this.store.settings.apply({ notify: r.notify, sessionsTtlDays: r.sessionsTtlDays, folders: r.folders, privacy: r.privacy }, r.seq))
        return;
      await this.store.flush();
      this.changed();
    });
  }
  fetchMe() {
    const gen = this.store.profile.gen;
    this.run(async () => {
      const me = await this.http("/me");
      if (this.store.profile.gen !== gen)
        return;
      if (!this.store.profile.setMe(me))
        return;
      await this.store.flush();
      this.changed();
    });
  }
  async peerKeyOf(userId) {
    const known = this.store.users.get(userId)?.key;
    if (known)
      return known;
    let r;
    try {
      r = await this.http(`/users?ids=${userId}`);
    } catch {
      return null;
    }
    for (const u of r.users)
      applyUserUpdated(this.store, u, r.seq);
    if (r.users.length) {
      await this.store.flush();
      this.changed();
    }
    return r.users.find((u) => u.id === userId)?.key ?? null;
  }
  wantPeople(ids) {
    for (const id of ids)
      if (id !== this.cfg.userId && !this.store.users.get(id) && !this.usersAsked.has(id))
        this.userWants.add(id);
  }
  fetchUsers() {
    if (!this.online || !this.ready || !this.userWants.size)
      return;
    const ids = [...this.userWants].filter((id) => !this.usersAsked.has(id));
    this.userWants.clear();
    for (const id of ids)
      this.usersAsked.add(id);
    for (let i = 0;i < ids.length; i += USERS_BATCH) {
      const part = ids.slice(i, i + USERS_BATCH);
      this.run(async () => {
        let r;
        try {
          r = await this.http(`/users?ids=${part.join(",")}`);
        } catch {
          if (!this.online)
            for (const id of part) {
              this.usersAsked.delete(id);
              this.userWants.add(id);
            }
          return;
        }
        for (const u of r.users)
          applyUserUpdated(this.store, u, r.seq);
        if (!r.users.length)
          return;
        await this.store.flush();
        this.changed();
      });
    }
  }
  async call(a) {
    this.acting++;
    try {
      return await this.act(a);
    } finally {
      this.acting--;
    }
  }
  async act(a) {
    switch (a.type) {
      case "scheduledEdit": {
        const p = { ...a.sendAt != null ? { sendAt: a.sendAt } : {}, ...a.body != null ? { body: a.body, entities: a.entities ?? [] } : {} };
        if (this.store.outbox.has(a.clientId)) {
          this.store.patchOutboxScheduled(a.clientId, p);
          await this.store.flush();
          this.changed();
          return null;
        }
        this.store.patchScheduled(a.clientId, p);
        await this.store.flush();
        await this.ops.enqueue({ key: OP_SCHEDULED + a.clientId, method: "PATCH", path: `/chats/${a.chatId}/scheduled/${a.clientId}`, body: p });
        return null;
      }
      case "scheduledSendNow": {
        if (this.store.outbox.has(a.clientId)) {
          this.store.patchOutboxScheduled(a.clientId, { sendAt: 1 });
          await this.store.flush();
          this.changed();
          this.pumpOutbox();
          return null;
        }
        this.store.removeScheduled(a.chatId, a.clientId);
        await this.store.flush();
        await this.ops.enqueue({ key: OP_SCHEDULED + a.clientId, method: "PATCH", path: `/chats/${a.chatId}/scheduled/${a.clientId}`, body: { send: true } });
        return null;
      }
      case "scheduledDelete": {
        if (this.store.outbox.has(a.clientId))
          return this.act({ type: "discard", clientId: a.clientId });
        this.store.removeScheduled(a.chatId, a.clientId);
        await this.store.flush();
        await this.ops.enqueue({ key: OP_SCHEDULED + a.clientId, method: "DELETE", path: `/chats/${a.chatId}/scheduled/${a.clientId}` });
        return null;
      }
      case "sendMessage": {
        const clientId = crypto.randomUUID();
        const draft = a.keepDraft ? null : await this.takeDraft(a.chatId);
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        this.store.addPending({
          clientId,
          chatId: a.chatId,
          body: a.body,
          entities: a.entities ?? [],
          replyToId: a.replyToId ?? null,
          ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {},
          createdAt: this.lastCreated,
          failed: false,
          draftHash: draft,
          ...a.noLinkPreview ? { noLinkPreview: true } : a.link ? { link: a.link } : {},
          ...a.attachment && a.attachment.id ? { attachment: a.attachment } : {},
          ...a.blocks && a.blocks.length ? { blocks: a.blocks } : {},
          ...a.silent ? { silent: true } : {},
          ...a.scheduleAt != null ? { scheduleAt: a.scheduleAt } : {},
          ...a.threadId != null ? { threadId: a.threadId } : {}
        });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        this.pushDrafts();
        return { clientId };
      }
      case "seen": {
        if (this.store.previews.has(a.chatId))
          return null;
        if (this.store.localRead(a.chatId, a.upToId)) {
          await this.store.flush();
          this.changed();
          this.scheduleReads();
        }
        return null;
      }
      case "markThreadRead": {
        if (this.store.localThreadRead(a.chatId, a.threadId, a.upToId)) {
          this.changed();
          this.scheduleReads();
        }
        return null;
      }
      case "nextMention":
        return this.store.nextMention(a.chatId);
      case "nextReaction": {
        const known = this.store.nextReaction(a.chatId);
        if (known != null)
          return known;
        if (!(this.store.chats.get(a.chatId)?.reactions ?? 0))
          return null;
        const r = await this.http(`/chats/${a.chatId}/reactions/unread`);
        this.store.setReactionIds(a.chatId, r.ids, r.count);
        this.changed();
        return r.ids[0] ?? null;
      }
      case "readReactions": {
        this.store.dropReactions(a.chatId, a.ids);
        this.changed();
        const ids = a.ids ? [...a.ids].sort((x, y) => x - y) : null;
        await this.ops.enqueue({ key: `reactions-read:${a.chatId}:${ids ? ids.join(",") : "all"}`, method: "POST", path: `/chats/${a.chatId}/reactions/read`, body: ids ? { ids } : {} });
        return null;
      }
      case "peerKey":
        return this.peerKeyOf(a.userId);
      case "readBy": {
        let res;
        try {
          res = await this.dev.fetch(`${this.cfg.httpBase}/chats/${a.chatId}/messages/${a.id}/read-by`, { credentials: "include", headers: this.cfg.headers });
        } catch {
          return { ok: false, code: "offline" };
        }
        if (this.session.unauthorized(res.status))
          return { ok: false, code: "offline" };
        const data = await res.json().catch(() => null);
        return res.ok ? { ok: true, data } : { ok: false, code: data?.code ?? "internal" };
      }
      case "loadThread": {
        await this.store.loadChatMessages(a.chatId);
        await this.loadThreadPage(a.chatId, a.threadId, (t) => t?.historyStart && t.ranges.length <= 1 ? undefined : t?.ranges[t.ranges.length - 1]?.[0] ?? null);
        return null;
      }
      case "loadOlder": {
        this.dev.log.record("engine", "loadOlder", { chatId: a.chatId });
        await this.store.loadChatMessages(a.chatId);
        const chat = this.store.chats.get(a.chatId);
        const span = chat && feedSpan(chat, this.store.chatMessages(a.chatId));
        if (span)
          await this.ensureHistory(a.chatId, undefined, span.hi - span.lo + (this.cfg.historyPage ?? 50));
        return null;
      }
      case "refreshChats": {
        if (this.online)
          this.refreshList();
        return null;
      }
      case "savedChat":
        return this.savedChat();
      case "loadSavedDialogs":
        if (this.online)
          await this.refreshSavedDialogs(true);
        return null;
      case "loadSaved": {
        await this.store.loadChatMessages(a.chatId);
        if (this.online)
          await this.loadSavedPage(a.chatId, a.peer);
        return null;
      }
      case "savedDialogPin": {
        const chat = savedChatOf(this.store);
        if (!chat)
          return null;
        await this.ops.enqueue({ key: savedPinKey(a.peer), method: "PUT", path: `/chats/${chat.id}/saved-dialogs/${a.peer}/pin`, body: { pinned: a.pinned, at: Date.now() } });
        return null;
      }
      case "savedDialogDelete": {
        const chat = savedChatOf(this.store);
        const row = this.store.savedDialogs.rows.get(a.peer);
        if (!chat || row?.lastId == null)
          return null;
        await this.store.loadChatMessages(chat.id);
        dropSavedLocally(this.store, chat.id, a.peer, row.lastId);
        await this.ops.enqueue({ key: savedDeleteKey(a.peer), method: "DELETE", path: `/chats/${chat.id}/saved-dialogs/${a.peer}?upToId=${row.lastId}` });
        await this.store.flush();
        this.changed();
        return null;
      }
      case "setDraft": {
        if (this.store.setDraft(a.chatId, a.text, a.entities)) {
          this.store.pendingDrafts.add(a.chatId);
          await this.store.flush();
          this.changed();
          this.pushDrafts();
        }
        return null;
      }
      case "typing":
        if (this.online && !this.store.chats.get(a.chatId)?.saved)
          this.transport.send({ op: "typing", chatId: a.chatId });
        return null;
      case "emojiFx":
        if (this.online)
          this.transport.send({ op: "emojiFx", chatId: a.chatId, id: a.id, key: a.key, t: a.t });
        return null;
      case "callFrame": {
        if (!this.online)
          throw new Error("offline");
        const f = a.frame;
        if (f.op === "callRequest" || f.op === "callAccept" || f.op === "callGet" || f.op === "groupCallStart" || f.op === "groupCallJoin" || f.op === "groupCallGet" || f.op === "groupCallEnd" || f.op === "groupCallMute" || f.op === "groupCallKick" || f.op === "groupCallSettings" || f.op === "groupCallAllow")
          return this.request({ ...f, reqId: "" });
        this.transport.send(f);
        return null;
      }
      case "editMessage": {
        if (!this.online)
          throw new Error("offline");
        await this.request({ op: "edit", reqId: "", chatId: a.chatId, id: a.id, body: a.body, entities: a.entities ?? [] });
        return null;
      }
      case "countViews":
        if (!this.store.previews.has(a.chatId))
          this.views.add(a.chatId, a.ids);
        return null;
      case "listened": {
        this.store.patchMessage(a.chatId, a.id, { listened: true });
        this.changed();
        if (this.online)
          this.run(async () => {
            await this.request({ op: "listened", reqId: "", chatId: a.chatId, id: a.id });
          });
        return null;
      }
      case "deleteMessage": {
        if (!this.online)
          throw new Error("offline");
        await this.request({ op: "delete", reqId: "", chatId: a.chatId, id: a.id });
        return null;
      }
      case "sendTodo": {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        const todo = { title: a.todo.title, items: a.todo.items.map((it, i) => ({ id: i + 1, title: it.title })), othersCanAppend: a.todo.othersCanAppend, othersCanComplete: a.todo.othersCanComplete, completions: [] };
        this.store.addPending({ clientId, chatId: a.chatId, body: a.todo.title, entities: [], replyToId: a.replyToId ?? null, ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {}, createdAt: this.lastCreated, failed: false, todo, draftHash: null });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case "sendPoll": {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        this.store.addPending({ clientId, chatId: a.chatId, body: a.poll.question, entities: [], replyToId: a.replyToId ?? null, ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {}, createdAt: this.lastCreated, failed: false, poll: a.poll });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case "sendSpecial": {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        let s = a.special;
        if (s.contact && !s.contact.key) {
          const key = await this.peerKeyOf(s.contact.userId);
          if (key)
            s = { ...s, contact: { ...s.contact, key } };
        }
        const body = s.contact ? s.contact.name : s.geo ? s.geo.title ?? "" : s.dice ? s.dice.emoji : "";
        this.store.addPending({ clientId, chatId: a.chatId, body, entities: [], replyToId: a.replyToId ?? null, ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {}, createdAt: this.lastCreated, failed: false, special: s, ...a.silent ? { silent: true } : {} });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        return { clientId };
      }
      case "pollVote": {
        if (!this.online)
          throw new Error("offline");
        const m = this.store.messageById(a.chatId, a.id);
        const prev = m?.poll;
        if (prev) {
          const had = new Set(prev.my ?? []), want = new Set(a.options);
          const counts = prev.options.map((o, i) => Math.max(0, prev.counts[i] - (had.has(o.id) ? 1 : 0) + (want.has(o.id) ? 1 : 0)));
          const voters = Math.max(0, prev.voters - (had.size ? 1 : 0) + (want.size ? 1 : 0));
          const { my: _, ...rest } = prev;
          this.store.patchMessage(a.chatId, a.id, { poll: { ...rest, counts, voters, ...want.size ? { my: [...want] } : {} } });
          this.changed();
        }
        try {
          await this.request({ op: "pollVote", reqId: "", chatId: a.chatId, id: a.id, options: a.options });
        } catch (e) {
          if (prev) {
            this.store.patchMessage(a.chatId, a.id, { poll: prev });
            this.changed();
          }
          throw e;
        }
        return null;
      }
      case "pollClose": {
        if (!this.online)
          throw new Error("offline");
        return this.request({ op: "pollClose", reqId: "", chatId: a.chatId, id: a.id });
      }
      case "todoToggle": {
        if (!this.online)
          throw new Error("offline");
        const m = this.store.messageById(a.chatId, a.id);
        const prev = m?.todo;
        if (prev) {
          const rest = prev.completions.filter((c) => c.id !== a.itemId);
          const completions = a.done ? rest.concat([{ id: a.itemId, by: this.cfg.userId, at: new Date().toISOString() }]) : rest;
          this.store.patchMessage(a.chatId, a.id, { todo: { ...prev, completions } });
          this.changed();
        }
        try {
          await this.request({ op: "todoToggle", reqId: "", chatId: a.chatId, id: a.id, completed: a.done ? [a.itemId] : [], incompleted: a.done ? [] : [a.itemId] });
        } catch (e) {
          if (prev) {
            this.store.patchMessage(a.chatId, a.id, { todo: prev });
            this.changed();
          }
          throw e;
        }
        return null;
      }
      case "todoAppend": {
        if (!this.online)
          throw new Error("offline");
        return this.request({ op: "todoAppend", reqId: "", chatId: a.chatId, id: a.id, items: a.items });
      }
      case "todoEdit": {
        if (!this.online)
          throw new Error("offline");
        return this.request({ op: "todoEdit", reqId: "", chatId: a.chatId, id: a.id, todo: a.todo });
      }
      case "pressButton": {
        if (!this.online)
          throw new Error("offline");
        return this.request({ op: "button", reqId: "", chatId: a.chatId, id: a.id, data: a.data });
      }
      case "react": {
        if (!this.online)
          throw new Error("offline");
        if (this.store.previews.has(a.chatId))
          throw new Error("not_member");
        const m = this.store.messageById(a.chatId, a.id);
        if (m?.post) {
          const prev = { reactionCounts: m.reactionCounts ?? [], myReaction: m.myReaction };
          this.store.patchMessage(a.chatId, a.id, { reactionCounts: shiftCounts(prev.reactionCounts, m.myReaction ?? null, a.emoji), myReaction: a.emoji ?? undefined });
          this.changed();
          try {
            const r = await this.request({ op: "react", reqId: "", chatId: a.chatId, id: a.id, emoji: a.emoji });
            if (r.counts) {
              this.store.patchMessage(a.chatId, a.id, { reactionCounts: r.counts, myReaction: r.mine ?? undefined });
              this.changed();
            }
          } catch (err) {
            this.store.patchMessage(a.chatId, a.id, prev);
            this.changed();
            throw err;
          }
          return null;
        }
        const prev = m?.reactions ?? [];
        if (m) {
          const next = prev.filter((r) => r.userId !== this.cfg.userId);
          if (a.emoji)
            next.push({ userId: this.cfg.userId, emoji: a.emoji });
          this.store.patchMessage(a.chatId, a.id, { reactions: next });
          this.changed();
        }
        try {
          await this.request({ op: "react", reqId: "", chatId: a.chatId, id: a.id, emoji: a.emoji });
        } catch (err) {
          if (m) {
            this.store.patchMessage(a.chatId, a.id, { reactions: prev });
            this.changed();
          }
          throw err;
        }
        return null;
      }
      case "resetLocal":
        return this.resetLocal(a.keepOutbox !== false);
      case "storageStats":
        return this.storageStats();
      case "dev":
        return this.dev.command(a).finally(() => this.pushStatus());
      case "search":
        return this.search(a);
      case "searchPeople":
        return this.searchPeople(a.q);
      case "searchChannels":
        return this.online ? this.http(`/search/channels?${new URLSearchParams({ q: a.q })}`).then((r) => r.channels) : [];
      case "openPreview":
        return this.openPreview(a.chatId);
      case "closePreview":
        return this.closePreview(a.chatId);
      case "searchMedia":
        return this.searchMedia(a.kind, a.q, a.before);
      case "topChats":
        return this.topChats();
      case "group": {
        if (!/^\/(groups|join)\//.test(a.path) && !/^\/chats\/\d+\/delete$/.test(a.path) && !(a.method === "GET" && /^\/chats\/\d+\/admin-log(\?|$)/.test(a.path)))
          return { ok: false, code: "bad_frame" };
        let res;
        try {
          res = await this.dev.fetch(this.cfg.httpBase + a.path, {
            method: a.method,
            credentials: "include",
            headers: a.body !== undefined ? { ...this.cfg.headers, "content-type": "application/json" } : this.cfg.headers,
            ...a.body !== undefined ? { body: JSON.stringify(a.body) } : {}
          });
        } catch {
          return { ok: false, code: "offline" };
        }
        if (this.session.unauthorized(res.status))
          return { ok: false, code: "offline" };
        const data = await res.json().catch(() => null);
        if (!res.ok)
          return { ok: false, code: data?.code ?? "internal", status: res.status };
        if (a.method !== "GET" && !this.resetting)
          this.runSync();
        return { ok: true, data };
      }
      case "pin":
      case "unpin": {
        const res = await this.http(a.type === "pin" ? `/chats/${a.chatId}/pins` : `/chats/${a.chatId}/pins${a.id != null ? "/" + a.id : ""}`, a.type === "pin" ? { method: "POST", body: JSON.stringify({ messageId: a.id }) } : { method: "DELETE" });
        this.store.applyUpdate({ type: "pins", chatId: a.chatId, ids: res.ids });
        this.changed();
        return res;
      }
      case "commonGroups":
        return this.http(`/users/${a.userId}/common-groups`).then((r) => r.groups);
      case "messagesByIds":
        return this.http(`/chats/${a.chatId}/messages?ids=${a.ids.slice(0, 100).join(",")}`).then((r) => r.messages);
      case "sendFile": {
        if (a.file.size > MAX_FILE_BYTES)
          throw new Error("file_too_big");
        const clientId = crypto.randomUUID();
        const draft = a.keepDraft ? null : await this.takeDraft(a.chatId);
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        await putBlob(this.db, clientId, a.file).catch((err) => {
          this.dev.log.error("putBlob", err);
          this.memBlobs.set(clientId, a.file);
        });
        const photo = !a.kind && /^image\//.test(a.mime) && !!a.w && !!a.h;
        const sized = photo || a.kind === "round" || a.kind === "video";
        this.store.addPending({
          clientId,
          chatId: a.chatId,
          body: a.body,
          replyToId: a.replyToId ?? null,
          ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {},
          createdAt: this.lastCreated,
          failed: false,
          draftHash: draft,
          ...a.groupId ? { groupId: a.groupId } : {},
          ...a.threadId != null ? { threadId: a.threadId } : {},
          ...a.silent ? { silent: true } : {},
          ...a.scheduleAt != null ? { scheduleAt: a.scheduleAt } : {},
          attachment: {
            id: "",
            kind: a.kind ?? (photo ? "photo" : "file"),
            mime: a.mime,
            name: a.name,
            size: a.file.size,
            w: sized ? a.w ?? null : null,
            h: sized ? a.h ?? null : null,
            thumb: a.thumb ?? null,
            ...a.kind ? { duration: a.duration ?? null, waveform: a.waveform ?? null } : {},
            ...a.kind === "audio" ? { title: a.title ?? null, performer: a.performer ?? null } : {},
            ...a.spoiler && (photo || a.kind === "video") ? { spoiler: true } : {}
          }
        });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        this.pushDrafts();
        return { clientId };
      }
      case "forwardMessages": {
        const srcs = a.ids.map((id) => this.store.messageById(a.fromChatId, id)).filter((m) => !!m && m.id != null && !m.deleted && !m.service);
        const clientIds = [];
        const queue = (o) => {
          const clientId = crypto.randomUUID();
          this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
          this.store.addPending({ ...o, clientId, createdAt: this.lastCreated, failed: false });
          clientIds.push(clientId);
        };
        let reply = a.hideSender && a.toChatIds.length === 1 ? a.replyToId ?? null : null;
        const takeReply = () => {
          const r = reply;
          reply = null;
          return r != null && a.replyQuote ? { replyToId: r, replyQuote: a.replyQuote } : { replyToId: r };
        };
        for (const chatId of a.toChatIds) {
          const comment = a.comment?.body.trim() ? a.comment : null;
          if (comment)
            queue({ chatId, body: comment.body, entities: comment.entities ?? [], ...takeReply(), draftHash: await this.takeDraft(chatId) });
          const groups = new Map;
          for (const m of srcs) {
            const dropCaption = !!a.hideCaption && !!m.attachment;
            const fwdFrom = a.hideSender ? null : m.fwdFrom ?? (m.post ? { userId: null, name: this.titleOfChat(a.fromChatId) ?? "", chatId: a.fromChatId, messageId: m.id, at: m.createdAt, ...m.postAuthor ? { postAuthor: m.postAuthor } : {} } : { userId: m.senderId, name: this.nameOf(m.senderId), chatId: a.fromChatId, messageId: m.id, at: m.createdAt });
            let groupId = null;
            if (m.groupId && m.attachment) {
              groupId = groups.get(m.groupId) ?? crypto.randomUUID();
              groups.set(m.groupId, groupId);
            }
            queue({
              chatId,
              body: dropCaption ? "" : m.body,
              entities: dropCaption ? [] : m.entities ?? [],
              ...takeReply(),
              attachment: m.attachment ?? null,
              draftHash: null,
              ...groupId ? { groupId } : {},
              forward: { chatId: a.fromChatId, id: m.id, ...a.hideSender ? { hideSender: true } : {}, ...a.hideCaption ? { hideCaption: true } : {} },
              fwdFrom
            });
          }
        }
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        this.pushDrafts();
        return { clientIds };
      }
      case "loadMoreChats":
        await this.loadMoreChats();
        return null;
      case "updateProfile": {
        const body = {};
        for (const k of ["firstName", "lastName", "bio", "birthday"])
          if (a[k] !== undefined)
            body[k] = a[k];
        if (Object.keys(body).length)
          await this.ops.enqueue({ key: OP_PROFILE, method: "PATCH", path: "/me", body });
        return null;
      }
      case "setLinks":
        await this.ops.enqueue({ key: OP_LINKS, method: "PATCH", path: "/me", body: { links: a.links } });
        return null;
      case "setPersonalChannel":
        await this.ops.enqueue({ key: OP_PCHANNEL, method: "PATCH", path: "/me", body: { personalChannelId: a.channel?.id ?? null, channel: a.channel } });
        return null;
      case "personalChannels":
        if (!this.online)
          return { offline: true };
        return this.http("/me/personal-channels").catch(() => ({ offline: true }));
      case "channelPost":
        return this.channelPosts.get(a.chatId, a.cached);
      case "setUsername":
        await this.ops.enqueue({ key: OP_USERNAME, method: "PUT", path: "/me/username", body: { username: a.username } });
        return null;
      case "refreshProfilePhotos":
        this.lists.refreshPhotos(this.cfg.userId);
        return null;
      case "refreshSettings":
        if (this.online && this.ready)
          this.fetchSettings();
        return null;
      case "positions":
        return this.store.positions();
      case "setPosition":
        await this.store.setPosition(a.key, a.pos);
        return null;
      case "setAutoDelete":
        await this.ops.enqueue({ key: autoDeleteKey(a.chatId), method: "PUT", path: `/chats/${a.chatId}/auto-delete`, body: { sec: a.sec } });
        return null;
      case "ackExpiredFiles":
        this.store.ackExpiredFiles(a.ids);
        await this.store.flush();
        this.pushStatus();
        return null;
      case "setMute":
        await this.ops.enqueue({ key: muteKey(a.chatId), method: "PUT", path: `/chats/${a.chatId}/notify`, body: { muteUntil: a.muteUntil } });
        return null;
      case "setChatFlags": {
        const c = this.store.chats.get(a.chatId);
        if (!c)
          return null;
        const cur = flagsOf(c, flagsOverlay(this.ops.list).get(a.chatId));
        const archived = a.archived ?? cur.archived;
        const pinned = a.pinned ?? (archived === cur.archived && cur.pinnedAt != null);
        await this.ops.enqueue({ key: flagsKey(a.chatId), method: "PUT", path: `/chats/${a.chatId}/flags`, body: { pinned, archived, unreadMark: a.unreadMark ?? cur.unreadMark, at: Date.now() } });
        return null;
      }
      case "setNotify": {
        const cur = settingsView(this.store.settings.base, this.ops.list).notify[a.notifyType];
        const body = { muted: a.muted ?? cur.muted, preview: a.preview ?? cur.preview };
        await this.ops.enqueue({ key: notifyKey(a.notifyType), method: "PUT", path: `/settings/notify/${a.notifyType}`, body });
        return null;
      }
      case "setPrivacy": {
        const body = normalizeRule(a.key, { mode: a.mode, allow: a.allow ?? [], deny: a.deny ?? [] });
        if (a.key === "phoneDiscovery") {
          body.allow = [];
          body.deny = [];
        }
        await this.ops.enqueue({ key: privacyKey(a.key), method: "PUT", path: `/privacy/${a.key}`, body });
        return null;
      }
      case "block":
      case "unblock":
        return this.blocks.act(a);
      case "addProfileMusic": {
        const track = trackOf(this.store, a.chatId, a.messageId);
        const key = track ? musicKey(track.id) : musicKey(`m${a.chatId}:${a.messageId}`);
        await this.ops.enqueue({ key, method: "POST", path: "/me/music", body: { chatId: a.chatId, messageId: a.messageId, ...track ? { track } : {} } });
        return { optimistic: !!track };
      }
      case "removeProfileMusic":
        await this.ops.enqueue({ key: musicKey(a.attId), method: "DELETE", path: `/me/music/${encodeURIComponent(a.attId)}` });
        return null;
      case "sendSticker": {
        const clientId = crypto.randomUUID();
        this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
        this.store.addPending({ clientId, chatId: a.chatId, body: "", entities: [], replyToId: a.replyToId ?? null, ...a.replyToId != null && a.replyQuote ? { replyQuote: a.replyQuote } : {}, createdAt: this.lastCreated, failed: false, sticker: a.sticker, draftHash: null, ...a.silent ? { silent: true } : {}, ...a.scheduleAt != null ? { scheduleAt: a.scheduleAt } : {}, ...a.threadId != null ? { threadId: a.threadId } : {} });
        await this.store.flush();
        this.changed();
        this.pumpOutbox();
        await this.stickers.bumpRecent(a.sticker).catch(() => {});
        return { clientId };
      }
      case "savedGifs":
      case "saveGif":
      case "removeGif":
        return this.gifs.act(a);
      case "myStickers":
      case "stickerSet":
      case "installStickerSet":
      case "faveSticker":
      case "clearRecentStickers":
      case "featuredStickerSets":
      case "searchStickerSets":
      case "stickersByEmoji":
      case "greetingSticker":
        return this.stickers.act(a);
      case "listSessions":
      case "terminateSession":
      case "terminateOtherSessions":
      case "confirmSession":
        return this.sessions.act(a);
      case "setSessionsTtl":
        await this.ops.enqueue({ key: OP_SESSIONS_TTL, method: "PUT", path: "/settings/sessions-ttl", body: { days: a.days } });
        return null;
      case "saveFolder": {
        const { id, ...body } = a.folder;
        await this.ops.enqueue({ key: folderKey(id), method: "PUT", path: `/settings/folders/${id}`, body });
        return null;
      }
      case "deleteFolder":
        await this.ops.enqueue({ key: folderKey(a.id), method: "DELETE", path: `/settings/folders/${a.id}` });
        return null;
      case "reorderFolders":
        await this.ops.enqueue({ key: OP_FOLDERS_ORDER, method: "PUT", path: "/settings/folders/order", body: { ids: a.ids } });
        return null;
      case "addContact":
      case "updateContact":
      case "removeContact":
      case "resolveUser":
        return this.contacts.act(a);
      case "checkUsername": {
        if (!this.online)
          return { offline: true };
        try {
          return await this.http(`/users/check-username?u=${encodeURIComponent(a.username)}`);
        } catch {
          return { offline: true };
        }
      }
      case "retry": {
        if (this.store.unfail(a.clientId)) {
          await this.store.flush();
          this.changed();
          this.pumpOutbox();
        }
        return null;
      }
      case "discard": {
        if (this.uploads.has(a.clientId)) {
          this.cancelled.add(a.clientId);
          this.uploads.get(a.clientId).abort();
        }
        const up = this.store.outbox.get(a.clientId)?.upload;
        if (up)
          this.dev.fetch(`${this.cfg.httpBase}/uploads/${up.id}`, { method: "DELETE", credentials: "include", headers: { ...this.cfg.headers ?? {} } }).catch(() => {});
        const ids = this.store.discard([a.clientId]);
        await this.store.flush();
        if (ids.length)
          await write(this.db, { put: {}, del: { messages: ids } }).catch(() => {});
        this.memBlobs.delete(a.clientId);
        delBlob(this.db, a.clientId).catch(() => {});
        this.changed();
        this.pumpOutbox();
        return null;
      }
    }
  }
  onOpen() {
    this.online = true;
    this.failures = 0;
    this.netDown = false;
    this.ready = false;
    this.changed();
    this.transport.send({ op: "hello", lastSeq: this.store.lastSeq, since: this.store.since });
  }
  onClose() {
    const wasOpen = this.online;
    this.online = false;
    this.holding = false;
    this.presence.clear();
    this.presenceDirty = true;
    this.presenceFetched = false;
    this.presenceTries.clear();
    this.forgetAsked();
    if (this.wantOnline)
      this.failures++;
    this.ready = false;
    this.changed();
    const offline = { code: "offline", retry: true };
    this.syncWaiter?.reject(offline);
    this.syncWaiter = null;
    for (const p of this.pending.values())
      p.reject(offline);
    this.pending.clear();
    for (const k of this.watchingThreads) {
      const [c, t] = k.split(":").map(Number);
      this.store.guestWatch(c, t, false);
    }
    this.watchingThreads.clear();
    this.refusedThreads.clear();
    for (const w of this.chatWaiters.values())
      w.reject(offline);
    this.chatWaiters.clear();
    for (const st of this.chatSync.values()) {
      if (st.gapTimer)
        clearTimeout(st.gapTimer);
      st.gapTimer = null;
      st.buffer.clear();
      st.again = false;
      st.queued = false;
    }
    this.chatQueue = [];
    this.sinceCandidate = null;
    if (!wasOpen && this.wantOnline)
      this.session.probe();
  }
  forgetAsked() {
    this.usersAsked.clear();
    this.membersAsked.clear();
    for (const w of this.watchers.values())
      if (w.q.kind === "members")
        this.membersWants.add(w.q.chatId);
    this.media.reconnect();
    this.lists.reconnect();
  }
  onFrame(f) {
    switch (f.op) {
      case "hello":
        if (this.resetting) {
          this.skipped.hello = f;
          return;
        }
        this.dev.counters.serverSeq = f.seq;
        this.callEvent({ op: "callResync" });
        if (typeof f.now === "number" && f.now > 0)
          this.store.setClockSkew(f.now - Date.now());
        this.sweepExpiry();
        this.holding = true;
        this.store.gifsRev++;
        if (this.hellos++ > 0) {
          this.store.sessionsRev++;
          this.store.stickersRev++;
          this.changed();
        }
        this.run(async () => {
          if (this.store.epoch && f.epoch && this.store.epoch !== f.epoch) {
            this.dev.log.record("engine", "epochWipe", { from: this.store.epoch, to: f.epoch });
            await this.store.wipe(f.epoch);
            this.clearAllChatState();
            this.ops.forget();
            this.forgetAsked();
            this.changed();
          } else if (!this.store.epoch && f.epoch) {
            this.store.epoch = f.epoch;
            this.store.markMeta();
          }
          this.fetchMe();
          this.fetchSettings();
          this.refreshScheduled();
          this.contacts.fetch();
          this.blocks.fetch();
          if (!this.store.hydrated)
            await this.bootstrap(f.seq);
          else
            this.runSync();
          this.onChatsList(f.chats ?? [], f.now);
          for (const id of this.watched)
            this.run(() => this.watchPreview(id));
        });
        return;
      case "chats":
        this.onChatsList(f.items, f.now);
        return;
      case "chatUpdates":
      case "chatTooLong":
      case "chatGone": {
        const w = this.chatWaiters.get(f.reqId);
        if (w && w.chatId === f.chatId)
          w.resolve(f);
        return;
      }
      case "updates":
      case "tooLong": {
        const w = this.syncWaiter;
        if (w && f.op === "updates" && f.from !== w.since)
          return;
        this.dev.counters.serverSeq = Math.max(this.dev.counters.serverSeq ?? 0, f.op === "updates" ? f.to : f.seq);
        this.syncWaiter = null;
        w?.resolve(f);
        return;
      }
      case "ack":
      case "err": {
        const id = f.reqId;
        if (!id)
          return;
        if (f.op === "err") {
          const cw = this.chatWaiters.get(id);
          if (cw) {
            cw.reject({ code: f.code, retry: f.retry });
            return;
          }
        }
        const p = this.pending.get(id);
        if (!p)
          return;
        this.pending.delete(id);
        if (f.op === "ack")
          p.resolve(f.result);
        else
          p.reject({ code: f.code, retry: f.retry });
        return;
      }
      case "poke":
        if (this.resetting)
          this.skipped.poke = true;
        this.runSync();
        return;
      case "threadPush": {
        if (!this.store.isGuest(f.chatId) || !this.watchingThreads.has(f.chatId + ":" + f.threadId))
          return;
        if (!f.items.length) {
          this.run(() => this.catchUpThread(f.chatId, f.threadId));
          return;
        }
        this.store.applyGuestPush(f.chatId, f.items);
        this.run(async () => {
          await this.store.flush();
          this.changed();
        });
        return;
      }
      case "push":
        if (f.chatId != null) {
          this.onChatPush(f);
          return;
        }
        if (this.resetting) {
          this.skipped.poke = true;
          return;
        }
        if (!this.ready || this.syncing || this.syncWaiter || f.from !== this.store.lastSeq || !this.online) {
          this.runSync();
          return;
        }
        this.run(() => this.applyPush(f));
        return;
      case "typing": {
        if (f.userId === this.cfg.userId || this.store.blocks.table.get(f.userId))
          return;
        if (this.store.chats.get(f.chatId)?.kind === "channel")
          return;
        const key = f.chatId + ":" + f.userId;
        clearTimeout(this.typingTimers.get(key));
        this.store.setTyping(f.chatId, f.userId, true);
        this.typingTimers.set(key, setTimeout(() => {
          this.typingTimers.delete(key);
          this.store.setTyping(f.chatId, f.userId, false);
          this.changed();
        }, this.cfg.typingMs ?? 6000));
        this.changed();
        return;
      }
      case "emojiFx": {
        if (f.userId === this.cfg.userId || this.store.blocks.table.get(f.userId))
          return;
        if (!this.store.messageById(f.chatId, f.id))
          return;
        this.store.emojiFx.set(f.chatId + ":" + f.id, { key: f.key, t: f.t, at: Date.now() });
        if (this.store.emojiFx.size > 200)
          this.store.emojiFx.clear();
        this.store.retouch(f.chatId);
        this.changed();
        return;
      }
      case "presence":
        for (const p of f.items)
          this.presence.set(p.userId, { online: p.online, lastSeen: p.lastSeen });
        this.presenceDirty = true;
        this.changed();
        return;
      case "challenge":
        signDevice("ws", f.nonce).then((sig) => this.transport.send({ op: "prove", sig }), () => this.transport.drop());
        return;
      case "callIncoming":
      case "callRinging":
      case "callAccepted":
      case "callConfirm":
      case "callSignal":
      case "callEnded":
      case "groupCallState":
      case "groupCallKeys":
      case "groupCallEnded":
      case "groupCallMuted":
      case "groupCallKicked":
        this.callEvent(f);
        return;
      case "sessionTerminated":
        this.session.end(f.reason === "logout" ? "logout" : "terminated");
        return;
      case "pong":
        return;
    }
  }
  async bootstrap(seq) {
    if (this.resetting)
      return;
    this.syncing = true;
    try {
      await this.loadFirstDialogs();
      this.store.lastSeq = seq;
      await this.store.flush();
      this.changed();
    } finally {
      this.syncing = false;
    }
    await this.syncLoop();
  }
  async applyPush(f) {
    if (this.syncing || this.resetting || f.from !== this.store.lastSeq) {
      this.runSync();
      return;
    }
    this.syncing = true;
    try {
      for (const chatId of patchedChats(f.items, this.store.lastSeq))
        await this.store.loadChatMessages(chatId);
      for (const it of f.items) {
        if (it.seq <= this.store.lastSeq)
          continue;
        this.store.applyUpdate(it.update, it.seq);
        this.store.lastSeq = it.seq;
      }
      await this.store.flush();
      this.dev.counters.serverSeq = Math.max(this.dev.counters.serverSeq ?? 0, f.to);
      this.dev.counters.pushed = (this.dev.counters.pushed ?? 0) + 1;
      this.changed();
    } finally {
      this.syncing = false;
    }
    if (this.syncAgain) {
      this.runSync();
      return;
    }
    if (this.store.unnamed().length)
      this.refreshList();
    this.loadOpenChats();
    this.fetchUsers();
    this.fetchMembers();
  }
  chatState(chatId) {
    let st = this.chatSync.get(chatId);
    if (!st)
      this.chatSync.set(chatId, st = { syncing: false, again: false, queued: false, buffer: new Map, gapTimer: null });
    return st;
  }
  clearAllChatState() {
    for (const st of this.chatSync.values())
      if (st.gapTimer)
        clearTimeout(st.gapTimer);
    this.chatSync.clear();
    this.chatQueue = [];
    this.refreshIds.clear();
    this.unknownAsked.clear();
    this.sinceCandidate = null;
  }
  isOpenChat(chatId) {
    for (const w of this.watchers.values())
      if (w.q.kind === "messages" && w.q.chatId === chatId)
        return true;
    return false;
  }
  topGroupChats(n = 20) {
    return new Set([...this.store.chats.values()].filter((c) => c.kind !== "direct" && !this.store.previews.has(c.id)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, n).map((c) => c.id));
  }
  onChatsList(items, now) {
    if (typeof now === "number" && now > 0)
      this.sinceCandidate = Math.max(this.sinceCandidate ?? 0, now);
    const top = this.topGroupChats();
    for (const [chatId, seq] of items) {
      const local = this.store.chatSeq.get(chatId);
      if (local == null) {
        this.askUnknownChat(chatId);
        continue;
      }
      if (seq > local)
        this.scheduleChatSync(chatId, this.isOpenChat(chatId) || top.has(chatId));
    }
    this.commitSince();
  }
  askUnknownChat(chatId) {
    const at = this.unknownAsked.get(chatId) ?? 0;
    if (Date.now() - at < 1e4)
      return;
    this.unknownAsked.set(chatId, Date.now());
    this.refreshRows([chatId]);
  }
  onChatPush(f) {
    if (this.resetting || !this.online)
      return;
    if (f.gone) {
      this.run(() => this.onChatDeleted(f.chatId));
      return;
    }
    const local = this.store.chatSeq.get(f.chatId);
    if (local == null) {
      this.askUnknownChat(f.chatId);
      return;
    }
    const st = this.chatState(f.chatId);
    if (st.syncing) {
      this.bufferPush(st, f);
      return;
    }
    if (!f.items.length) {
      this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId));
      return;
    }
    if (f.from === local) {
      st.syncing = true;
      this.run(async () => {
        let gap = false;
        try {
          await this.applyChatItems(f.chatId, f.items, f.to);
          gap = await this.drainChatBuffer(f.chatId);
        } finally {
          st.syncing = false;
        }
        if (gap)
          this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId));
        else if (st.again) {
          st.again = false;
          this.scheduleChatSync(f.chatId, this.isOpenChat(f.chatId));
        }
      });
      return;
    }
    if (f.from > local) {
      this.bufferPush(st, f);
      this.startGapTimer(f.chatId);
    }
  }
  async onChatDeleted(chatId) {
    this.dev.log.record("engine", "chatGone", { chatId });
    if (this.store.previews.has(chatId)) {
      await this.forgetPreview(chatId, false);
      return;
    }
    const st = this.chatSync.get(chatId);
    if (st?.gapTimer)
      clearTimeout(st.gapTimer);
    this.chatSync.delete(chatId);
    this.store.removeChat(chatId);
    await this.store.flush();
    this.changed();
  }
  bufferPush(st, f) {
    if (st.buffer.size >= 200) {
      st.buffer.clear();
      this.scheduleChatSync(f.chatId, true);
      return;
    }
    st.buffer.set(f.from, f);
  }
  startGapTimer(chatId) {
    const st = this.chatState(chatId);
    if (st.gapTimer)
      return;
    st.gapTimer = setTimeout(() => {
      st.gapTimer = null;
      if (st.buffer.size && !st.syncing) {
        this.dev.log.record("engine", "chatGap", { chatId });
        this.scheduleChatSync(chatId, this.isOpenChat(chatId));
      }
    }, this.cfg.chatGapMs ?? 700);
  }
  async drainChatBuffer(chatId) {
    const st = this.chatState(chatId);
    for (;; ) {
      const local = this.store.chatSeq.get(chatId);
      if (local == null) {
        st.buffer.clear();
        return false;
      }
      for (const k of [...st.buffer.keys()])
        if (k < local)
          st.buffer.delete(k);
      const next = st.buffer.get(local);
      if (!next) {
        const gap = st.buffer.size > 0;
        if (!gap && st.gapTimer) {
          clearTimeout(st.gapTimer);
          st.gapTimer = null;
        }
        return gap;
      }
      st.buffer.delete(local);
      if (!next.items.length) {
        st.buffer.clear();
        return true;
      }
      await this.applyChatItems(chatId, next.items, next.to);
    }
  }
  scheduleChatSync(chatId, urgent) {
    const st = this.chatState(chatId);
    if (st.syncing) {
      st.again = true;
      return;
    }
    if (st.queued) {
      if (urgent)
        this.chatQueue = [chatId, ...this.chatQueue.filter((id) => id !== chatId)];
      return;
    }
    st.queued = true;
    if (urgent)
      this.chatQueue.unshift(chatId);
    else
      this.chatQueue.push(chatId);
    this.pumpChatQueue();
  }
  pumpChatQueue() {
    while (this.chatActive < 4 && this.chatQueue.length && this.online && !this.resetting) {
      const chatId = this.chatQueue.shift();
      const st = this.chatState(chatId);
      st.queued = false;
      if (st.syncing) {
        st.again = true;
        continue;
      }
      st.syncing = true;
      this.chatActive++;
      this.run(() => this.runSyncChat(chatId).finally(() => {
        st.syncing = false;
        this.chatActive = Math.max(0, this.chatActive - 1);
        this.pumpChatQueue();
        this.commitSince();
      }));
    }
  }
  async runSyncChat(chatId) {
    const st = this.chatState(chatId);
    for (let round = 0;round < 50 && this.online; round++) {
      st.again = false;
      let more = true;
      while (more && this.online) {
        const since = this.store.chatSeq.get(chatId);
        if (since == null)
          return;
        let f;
        try {
          f = await this.requestSyncChat(chatId, since);
        } catch {
          return;
        }
        if (f.op === "chatGone") {
          this.dev.log.record("engine", "chatGone", { chatId });
          if (this.store.previews.has(chatId)) {
            st.buffer.clear();
            await this.forgetPreview(chatId);
            return;
          }
          this.store.removeChat(chatId);
          st.buffer.clear();
          await this.store.flush();
          this.changed();
          return;
        }
        if (f.op === "chatTooLong") {
          this.dev.log.record("engine", "chatTooLong", { chatId, seq: f.seq });
          await this.store.resetChat(chatId);
          this.store.setChatSeq(chatId, f.seq);
          st.buffer.clear();
          await this.store.flush();
          for (const w of this.watchers.values())
            if (w.q.kind === "messages" && w.q.chatId === chatId) {
              const q = w.q;
              this.run(() => this.ensureWindow(q));
            }
          this.changed();
          return;
        }
        await this.applyChatItems(chatId, f.items, f.to);
        more = f.more;
      }
      const gap = await this.drainChatBuffer(chatId);
      if (!gap && !st.again)
        break;
    }
  }
  requestSyncChat(chatId, since) {
    return new Promise((resolve, reject) => {
      const reqId = "c" + ++this.reqSeq;
      let tries = 0, stop = () => {};
      const w = {
        chatId,
        resolve: (f) => {
          stop();
          this.chatWaiters.delete(reqId);
          resolve(f);
        },
        reject: (e) => {
          stop();
          this.chatWaiters.delete(reqId);
          reject(e);
        }
      };
      this.chatWaiters.set(reqId, w);
      const send = () => this.transport.send({ op: "syncChat", reqId, chatId, since });
      const resend = () => {
        if (!this.chatWaiters.has(reqId))
          return;
        this.dev.log.record("engine", "syncChatTimeout", { chatId, since, tries: ++tries });
        if (tries >= 3 || !send()) {
          w.reject({ code: "offline", retry: true });
          return;
        }
        stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
      };
      if (!send()) {
        w.reject({ code: "offline", retry: true });
        return;
      }
      stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
    });
  }
  async applyChatItems(chatId, items, to) {
    const local = this.store.chatSeq.get(chatId);
    if (local == null)
      return;
    const chat = this.store.chats.get(chatId);
    const historyFrom = chat?.me?.historyFrom ?? 0;
    for (const id of patchedChats(items, local))
      await this.store.loadChatMessages(id);
    for (const it of items) {
      if (it.seq <= local)
        continue;
      const u = it.update;
      const mid = u.type === "newMessage" ? u.message.id : u.type !== "pins" && ("id" in u) && typeof u.id === "number" ? u.id : null;
      if (mid != null && historyFrom && mid < historyFrom)
        continue;
      if (u.type === "newMessage" && chat)
        this.maybeUnarchive(chat, u.message);
      this.store.applyUpdate(u, it.seq);
    }
    this.store.setChatSeq(chatId, Math.max(local, to));
    this.dev.counters.pushed = (this.dev.counters.pushed ?? 0) + 1;
    await this.store.flush();
    this.changed();
    if (this.store.unnamed().length)
      this.refreshList();
    this.fetchUsers();
    this.fetchMembers();
  }
  maybeUnarchive(chat, m) {
    if (chat.kind === "direct" || !chat.archived || m.senderId === this.cfg.userId)
      return;
    const mute = chat.muteUntil;
    if (mute === 0 || mute != null && mute > Date.now())
      return;
    if (m.id <= (chat.archivedAtId ?? 0))
      return;
    if (this.ops.list.some((o) => o.key === flagsKey(chat.id)))
      return;
    this.ops.enqueue({ key: "unarchive:" + chat.id, method: "POST", path: `/chats/${chat.id}/unarchive`, body: { messageId: m.id } });
  }
  async openPreview(chatId) {
    let res;
    try {
      res = await this.dev.fetch(`${this.cfg.httpBase}/groups/${chatId}`, { credentials: "include", headers: this.cfg.headers });
    } catch {
      return { error: "offline" };
    }
    if (this.session.unauthorized(res.status))
      return { error: "offline" };
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.chat)
      return { error: data?.code ?? "internal" };
    if (data.member) {
      this.store.applyChats([data.chat], this.store.lastSeq);
    } else if (!this.store.chats.has(chatId) || this.store.previews.has(chatId)) {
      const again = this.watched.has(chatId);
      this.store.applyPreview(data.chat, !!data.requested);
      if (!again && this.online) {
        const err = await this.watchPreview(chatId);
        if (err)
          return { error: err };
      }
    }
    await this.store.flush();
    this.changed();
    return { member: !!data.member, requested: !!data.requested };
  }
  async watchPreview(chatId) {
    if (!this.store.previews.has(chatId)) {
      this.watched.delete(chatId);
      return null;
    }
    this.watched.add(chatId);
    if (!this.online)
      return null;
    let r;
    try {
      r = await this.request({ op: "watchChat", reqId: "", chatId });
    } catch (e) {
      const code = e.code;
      if (code === "offline" || e.retry)
        return null;
      await this.forgetPreview(chatId, false);
      return code;
    }
    const local = this.store.chatSeq.get(chatId);
    if (typeof r.seq === "number" && local != null && r.seq > local)
      this.scheduleChatSync(chatId, true);
    return null;
  }
  async forgetPreview(chatId, unwatch = true) {
    this.watched.delete(chatId);
    if (unwatch && this.online)
      this.transport.send({ op: "unwatchChat", chatId });
    if (!this.store.previews.has(chatId))
      return;
    const st = this.chatSync.get(chatId);
    if (st?.gapTimer)
      clearTimeout(st.gapTimer);
    this.chatSync.delete(chatId);
    this.store.dropPreview(chatId);
    await this.store.flush();
    this.changed();
  }
  async closePreview(chatId) {
    if (!this.watched.has(chatId))
      return null;
    for (const w of this.watchers.values())
      if ((w.q.kind === "messages" || w.q.kind === "media") && w.q.chatId === chatId)
        return null;
    if (this.store.previews.has(chatId))
      await this.forgetPreview(chatId);
    else {
      this.watched.delete(chatId);
      if (this.online)
        this.transport.send({ op: "unwatchChat", chatId });
    }
    return null;
  }
  refreshRows(ids) {
    for (const id of ids)
      this.refreshIds.add(id);
    if (this.refreshTimer || !this.online)
      return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.runRefreshRows();
    }, 300);
  }
  runRefreshRows() {
    if (this.rowsInFlight || !this.refreshIds.size || !this.online || !this.store.hydrated)
      return;
    if (this.syncing || this.chatActive) {
      this.refreshRows([]);
      return;
    }
    const ids = [...this.refreshIds].slice(0, 500);
    for (const id of ids)
      this.refreshIds.delete(id);
    this.rowsInFlight = true;
    this.run(async () => {
      try {
        const seq = this.store.lastSeq;
        const list = await this.http(`/chats?ids=${ids.join(",")}`);
        this.store.applyChats(list, seq);
        await this.store.flush();
        this.changed();
      } finally {
        this.rowsInFlight = false;
        if (this.refreshIds.size)
          this.refreshRows([]);
      }
    });
  }
  handleSeqHints() {
    if (!this.store.seqHints.size)
      return;
    const hints = [...this.store.seqHints];
    this.store.seqHints.clear();
    const top = this.topGroupChats();
    for (const [chatId, h] of hints) {
      if (h === "new")
        this.refreshRows([chatId]);
      else if (this.online)
        this.scheduleChatSync(chatId, this.isOpenChat(chatId) || top.has(chatId));
    }
  }
  commitSince() {
    if (this.sinceCandidate == null || this.syncing || this.chatActive || this.chatQueue.length || !this.online || !this.ready)
      return;
    const v = this.sinceCandidate;
    this.sinceCandidate = null;
    this.store.setSince(v);
    this.run(() => this.store.flush());
  }
  runSync() {
    if (this.resetting)
      return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.run(() => this.syncLoop());
  }
  async syncLoop() {
    if (this.resetting)
      return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    const snaps = this.store.pendingSnapshots();
    let caughtUp = false;
    try {
      do {
        this.syncAgain = false;
        let more = true;
        while (more && this.online) {
          const f = await this.requestSync(this.store.lastSeq);
          const gap = f.op === "updates" && f.more && f.items.length === 0;
          if (f.op === "tooLong" || gap) {
            this.dev.counters.tooLongCount++;
            this.dev.log.record("engine", "snapshot", { reason: gap ? "gap" : "tooLong" });
            this.store.resetForSnapshot();
            this.store.resetDialogs();
            this.contacts.fetch();
            this.blocks.fetch();
            this.fetchSettings();
            this.store.stickersRev++;
            this.store.gifsRev++;
            this.store.sessionsRev++;
            await this.loadFirstDialogs();
            this.store.lastSeq = f.op === "tooLong" ? f.seq : f.to;
            await this.store.flush();
            this.changed();
            if (gap)
              break;
            continue;
          }
          for (const chatId of patchedChats(f.items, this.store.lastSeq))
            await this.store.loadChatMessages(chatId);
          for (const it of f.items) {
            if (it.seq <= this.store.lastSeq)
              continue;
            this.store.applyUpdate(it.update, it.seq);
            this.store.lastSeq = it.seq;
          }
          await this.store.flush();
          this.changed();
          more = f.more;
        }
      } while (this.syncAgain && this.online);
      caughtUp = this.online;
    } finally {
      this.syncing = false;
    }
    if (caughtUp && snaps.size) {
      this.store.settleSnapshots(snaps);
      await this.store.flush();
    }
    if (this.online) {
      this.ready = true;
      this.dev.counters.lastSyncAt = Date.now();
      this.holding = false;
      this.changed();
      this.pumpOutbox();
      this.flushReads();
      this.pushDrafts();
      if (this.store.unnamed().length)
        this.refreshList();
      this.loadOpenChats();
      this.run(() => this.refreshSavedDialogs());
      if (!this.presenceFetched)
        this.fetchPresence();
      this.ops.resume();
      if (!this.peersRefreshed)
        this.refreshPeers();
      this.fetchUsers();
      this.fetchMembers();
      this.commitSince();
    }
  }
  refreshPeers() {
    this.peersRefreshed = true;
    const top = [...this.store.chats.values()].filter((c) => c.kind === "direct" && c.peerId != null && !c.system && c.peerId !== this.cfg.userId).sort((a, b) => a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0).slice(0, this.cfg.dialogsPage ?? 100);
    for (const c of top)
      if (!this.usersAsked.has(c.peerId))
        this.userWants.add(c.peerId);
  }
  askUnknownPresence() {
    if (!this.online || !this.presenceFetched)
      return;
    const now = Date.now();
    for (const w of this.watchers.values()) {
      if (w.q.kind !== "presence" || this.presence.has(w.q.userId) || w.q.userId === this.cfg.userId)
        continue;
      const t = this.presenceTries.get(w.q.userId);
      if (t && t.n >= 5)
        continue;
      if (t && now - t.at < 1500) {
        if (!this.presenceRetry) {
          this.presenceRetry = setTimeout(() => {
            this.presenceRetry = null;
            this.askUnknownPresence();
          }, 1500 - (now - t.at));
          this.presenceRetry.unref?.();
        }
        return;
      }
      this.presenceTries.set(w.q.userId, { n: (t?.n ?? 0) + 1, at: now });
      this.fetchPresence();
      return;
    }
  }
  fetchPresence() {
    this.presenceFetched = true;
    this.run(async () => {
      const list = await this.http("/presence");
      if (!this.online)
        return;
      for (const p of list)
        if (!this.presence.has(p.userId))
          this.presence.set(p.userId, { online: p.online, lastSeen: p.lastSeen });
      this.presenceDirty = true;
      this.changed();
    });
  }
  async loadFirstDialogs() {
    const seq = this.store.lastSeq;
    const [page, unread, pinned, archived] = await Promise.all([
      this.http(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`),
      this.http("/chats?unread=1"),
      this.http("/chats?pinned=1"),
      this.http("/chats?archived=1")
    ]);
    this.store.applyChats([...page.chats, ...unread, ...pinned, ...archived], seq);
    this.store.setDialogsCursor(page.next, page.total);
  }
  loadMoreChats() {
    if (this.store.dialogsDone || !this.store.hydrated)
      return Promise.resolve();
    this.moreChats ??= (async () => {
      try {
        const at = new Date(this.store.dialogsAt).toISOString();
        const seq = this.store.lastSeq;
        const page = await this.http(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}&beforeAt=${encodeURIComponent(at)}&beforeId=${this.store.dialogsId}`);
        this.store.applyChats(page.chats, seq);
        this.store.setDialogsCursor(page.next);
        await this.store.flush();
        this.changed();
      } finally {
        this.moreChats = null;
      }
    })();
    return this.moreChats;
  }
  ensureOpenChat(chatId) {
    const c = this.store.chats.get(chatId);
    if (c && !Store.unnamed(c) || !this.store.hydrated || !this.online)
      return Promise.resolve();
    let p = this.chatLoads.get(chatId);
    if (!p) {
      p = (async () => {
        const seq = this.store.lastSeq;
        const list = await this.http(`/chats?ids=${chatId}`);
        if (!list.length)
          return;
        this.store.applyChats(list, seq);
        await this.store.flush();
        this.changed();
      })().finally(() => this.chatLoads.delete(chatId));
      this.chatLoads.set(chatId, p);
    }
    return p;
  }
  async savedChat() {
    for (const c of this.store.chats.values())
      if (c.saved)
        return c.id;
    const seq = this.store.lastSeq;
    const { id } = await this.http("/chats/saved", { method: "POST" });
    this.store.applyChats(await this.http(`/chats?ids=${id}`), seq);
    await this.store.flush();
    this.changed();
    return id;
  }
  loadOpenChats() {
    for (const w of this.watchers.values()) {
      const q = w.q;
      if (q.kind === "thread") {
        if (!this.store.threadRanges(q.chatId, q.threadId))
          this.run(() => this.ensureThreadWindow(q));
        continue;
      }
      if (q.kind === "savedFeed") {
        this.run(() => this.ensureSavedWindow(q));
        continue;
      }
      if (q.kind !== "messages")
        continue;
      const c = this.store.chats.get(q.chatId);
      if (c && !Store.unnamed(c)) {
        this.run(() => this.ensureWindow(q));
        continue;
      }
      this.run(() => this.ensureOpenChat(q.chatId).then(() => this.ensureWindow(q)));
    }
  }
  refreshList() {
    if (this.refreshing)
      return;
    this.refreshing = true;
    this.run(async () => {
      try {
        const unnamed = this.store.unnamed();
        const seq = this.store.lastSeq;
        const list = unnamed.length ? await this.http(`/chats?ids=${unnamed.slice(0, 500).join(",")}`) : (await this.http(`/chats/page?limit=${this.cfg.dialogsPage ?? 100}`)).chats;
        this.store.applyChats(list, seq);
        await this.store.flush();
        this.changed();
      } finally {
        this.refreshing = false;
      }
    });
  }
  requestSync(since) {
    return new Promise((resolve, reject) => {
      let tries = 0, stop = () => {};
      const resend = () => {
        if (this.syncWaiter !== w)
          return;
        this.dev.log.record("engine", "syncTimeout", { since, tries: ++tries });
        if (tries >= 3 || !this.transport.send({ op: "sync", since })) {
          this.syncWaiter = null;
          w.reject({ code: "offline", retry: true });
          this.transport.drop();
          return;
        }
        stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
      };
      const w = { since, resolve: (f) => {
        stop();
        resolve(f);
      }, reject: (e) => {
        stop();
        reject(e);
      } };
      this.syncWaiter = w;
      if (!this.transport.send({ op: "sync", since })) {
        this.syncWaiter = null;
        reject({ code: "offline", retry: true });
        return;
      }
      stop = watchLoss(this.dev.sim, this.cfg.syncTimeoutMs ?? 5000, resend);
    });
  }
  request(frame) {
    const reqId = "r" + ++this.reqSeq;
    return new Promise((resolve, reject) => {
      let stop = () => {};
      this.pending.set(reqId, { resolve: (r) => {
        stop();
        resolve(r);
      }, reject: (e) => {
        stop();
        reject(e);
      } });
      if (!this.transport.send({ ...frame, reqId })) {
        this.pending.delete(reqId);
        reject({ code: "offline", retry: true });
        return;
      }
      stop = watchLoss(this.dev.sim, this.cfg.requestTimeoutMs ?? 15000, () => {
        if (!this.pending.delete(reqId))
          return;
        this.dev.log.record("engine", "requestTimeout", { op: frame.op, reqId });
        reject({ code: "offline", retry: true });
        this.transport.drop();
      });
    });
  }
  async resync() {
    if (!this.online || !this.ready)
      throw new Error("offline");
    this.fetchMe();
    this.fetchSettings();
    this.contacts.fetch();
    this.blocks.fetch();
    await this.loadFirstDialogs();
    await this.store.flush();
    this.changed();
    this.runSync();
  }
  simOffline(on) {
    this.netDown = on || typeof navigator !== "undefined" && navigator.onLine === false;
    this.changed();
    if (!on) {
      this.transport.setOffline(false);
      return;
    }
    this.run(async () => {
      const end = Date.now() + 5000;
      while ((this.pending.size || this.syncWaiter) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 10));
      if (this.dev.sim.offline)
        this.transport.setOffline(true);
    });
  }
  async retryFailed() {
    let n = 0;
    for (const o of [...this.store.outbox.values()])
      if (o.failed && this.store.unfail(o.clientId))
        n++;
    await this.store.flush();
    this.changed();
    this.pumpOutbox();
    this.ops.resume();
    return n;
  }
  async discardFailed() {
    const ids = this.store.discardFailed();
    await this.store.flush();
    if (ids.length)
      await write(this.db, { put: {}, del: { messages: ids } }).catch(() => {});
    for (const id of ids) {
      this.memBlobs.delete(id);
      delBlob(this.db, id).catch(() => {});
    }
    this.changed();
    return ids.length;
  }
  outboxTimer = null;
  outboxAttempt = 0;
  retryOutboxLater() {
    if (this.outboxTimer || this.closed)
      return;
    const ms = [1000, 2000, 5000, 1e4, 30000][Math.min(this.outboxAttempt++, 4)];
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      this.pumpOutbox();
    }, ms);
  }
  uploading = new Set;
  cancelled = new Set;
  static needsUpload(o) {
    return !!o.attachment && !o.attachment.id && !o.forward;
  }
  pumpOutbox() {
    if (this.resetting || !this.online || !this.ready)
      return;
    this.startUpload();
    if (this.pumping)
      return;
    this.pumping = true;
    this.run(async () => {
      try {
        for (;; ) {
          const next = this.nextToSend();
          if (!next || !this.online)
            break;
          if (next.scheduleAt != null && next.scheduleAt <= Date.now()) {
            this.promoteToSend(next.clientId);
            await this.store.flush();
            this.changed();
          }
          const planned = next.scheduleAt != null ? { at: next.scheduleAt, body: next.body, entities: next.entities } : null;
          try {
            const att = next.attachment ? { id: next.attachment.id, thumb: next.attachment.thumb ?? null, ...next.attachment.spoiler ? { spoiler: true } : {} } : null;
            const r = await this.request({ op: "send", reqId: "", clientId: next.clientId, chatId: next.chatId, body: next.body, entities: next.entities ?? [], replyToId: next.replyToId, ...next.replyQuote ? { replyQuote: { text: next.replyQuote.text, offset: next.replyQuote.offset } } : {}, attachment: next.forward ? null : att, ...next.groupId ? { groupId: next.groupId } : {}, ...next.forward ? { forward: next.forward } : {}, ...next.noLinkPreview ? { noLinkPreview: true } : {}, ...next.blocks ? { blocks: next.blocks } : {}, ...next.sticker ? { sticker: { id: next.sticker.id } } : {}, ...next.todo ? { todo: { title: next.todo.title, items: next.todo.items.map((x) => ({ title: x.title })), othersCanAppend: next.todo.othersCanAppend, othersCanComplete: next.todo.othersCanComplete } } : {}, ...next.poll ? { poll: next.poll } : {}, ...next.special?.contact ? { contact: { userId: next.special.contact.userId, ...next.special.contact.key ? { key: next.special.contact.key } : {} } } : {}, ...next.special?.geo ? { geo: next.special.geo } : {}, ...next.special?.dice ? { dice: next.special.dice } : {}, ...next.silent ? { silent: true } : {}, ...planned ? { scheduleAt: planned.at } : {}, ...next.threadId != null ? { threadId: next.threadId } : {}, ...next.draftHash !== undefined ? { draftHash: next.draftHash } : {} });
            if (planned) {
              const now = this.store.outbox.get(next.clientId);
              this.store.ackScheduled(next.clientId, r.item);
              const path = `/chats/${next.chatId}/scheduled/${next.clientId}`;
              if (!now) {
                this.store.removeScheduled(next.chatId, next.clientId);
                await this.ops.enqueue({ key: OP_SCHEDULED + next.clientId, method: "DELETE", path });
              } else if (now.scheduleAt !== planned.at || now.body !== planned.body || now.entities !== planned.entities) {
                const p = { sendAt: now.scheduleAt, body: now.body, entities: now.entities ?? [] };
                this.store.patchScheduled(next.clientId, p);
                await this.ops.enqueue({ key: OP_SCHEDULED + next.clientId, method: "PATCH", path, body: p });
              }
              if (att) {
                this.memBlobs.delete(next.clientId);
                delBlob(this.db, next.clientId).catch(() => {});
              }
              await this.store.flush();
              this.changed();
              continue;
            }
            this.store.ack(next.clientId, r.id, r.createdAt);
            const c = this.store.chats.get(next.chatId), live = c?.ranges[c.ranges.length - 1];
            if (c?.seed != null && live && live[0] < c.seed) {
              const id = next.chatId;
              this.run(() => this.ensureHistory(id, undefined, 0));
            }
            this.outboxAttempt = 0;
            if (att) {
              this.memBlobs.delete(next.clientId);
              delBlob(this.db, next.clientId).catch(() => {});
            }
          } catch (e) {
            if (e.code === "schedule_past" && this.store.outbox.has(next.clientId))
              this.promoteToSend(next.clientId);
            else if (e.code === "quote_gone" && this.store.dropQuote(next.clientId)) {} else if (e.retry === false)
              this.store.fail(next.clientId, e.code);
            else {
              if (e.code !== "offline")
                this.retryOutboxLater();
              break;
            }
          }
          await this.store.flush();
          this.changed();
          this.pushDrafts();
        }
      } finally {
        this.pumping = false;
      }
    });
  }
  promoteToSend(clientId) {
    this.lastCreated = Math.max(Date.now(), this.lastCreated + 1);
    this.store.promoteScheduled(clientId, this.lastCreated);
  }
  nextToSend() {
    const waiting = new Set;
    for (const o of this.store.outbox.values()) {
      if (o.failed)
        continue;
      if (Engine.needsUpload(o)) {
        waiting.add(o.chatId);
        continue;
      }
      if (o.attachment && !o.forward && waiting.has(o.chatId))
        continue;
      return o;
    }
    return;
  }
  startUpload() {
    while (this.uploading.size < UPLOAD_SLOTS && !this.resetting && this.online && this.ready) {
      const next = [...this.store.outbox.values()].find((o) => !o.failed && Engine.needsUpload(o) && !this.uploading.has(o.clientId));
      if (!next)
        return;
      this.uploadOne(next);
    }
  }
  uploadOne(next) {
    const clientId = next.clientId;
    this.uploading.add(clientId);
    let again = true;
    this.run(async () => {
      try {
        const blob = this.memBlobs.get(clientId) ?? await getBlob(this.db, clientId);
        if (!blob) {
          this.store.fail(clientId);
          return;
        }
        const up = await this.upload(clientId, blob, next.attachment);
        if (this.store.outbox.has(clientId))
          this.store.setUploaded(clientId, up.id);
      } catch (e) {
        if (e.retry === false)
          this.store.fail(clientId, e.code);
        else {
          again = false;
          if (e.code !== "offline")
            this.retryOutboxLater();
        }
      } finally {
        this.uploading.delete(clientId);
        this.cancelled.delete(clientId);
        await this.store.flush();
        this.changed();
        if (again)
          this.pumpOutbox();
      }
    });
  }
  scheduleReads() {
    if (this.readTimer || this.closed)
      return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.flushReads();
    }, this.cfg.readFlushMs ?? 1000);
  }
  flushReads() {
    if (!this.online || !this.ready || !this.store.pendingReads.size && !this.store.pendingThreadReads.size)
      return;
    this.run(async () => {
      for (const [k, upToId] of [...this.store.pendingThreadReads]) {
        const [chatId, threadId] = k.split(":").map(Number);
        try {
          await this.http(`/chats/${chatId}/threads/${threadId}/read`, { method: "PUT", body: JSON.stringify({ upToId }) });
          if ((this.store.pendingThreadReads.get(k) ?? 0) <= upToId)
            this.store.pendingThreadReads.delete(k);
        } catch (e) {
          if (/HTTP 4\d\d/.test(String(e?.message ?? "")))
            this.store.pendingThreadReads.delete(k);
          else
            break;
        }
      }
      for (const [chatId, upToId] of [...this.store.pendingReads]) {
        try {
          await this.request({ op: "read", reqId: "", chatId, upToId });
          this.store.readSent(chatId, upToId);
        } catch (e) {
          if (e.retry === false)
            this.store.readSent(chatId, upToId);
          else
            break;
        }
      }
      await this.store.flush();
      if ((this.store.pendingReads.size || this.store.pendingThreadReads.size) && this.online)
        this.scheduleReads();
    });
  }
  async ensureWindow(q) {
    const page = this.cfg.historyPage ?? 50;
    for (let guard = 0;guard < 200; guard++) {
      const chat = this.store.chats.get(q.chatId);
      if (!chat)
        return;
      const all = this.store.chatMessages(q.chatId);
      const span = feedSpan(chat, all, q.anchor?.sort);
      const { from, to } = messageWindow(all, q, span.lo, span.hi);
      const have = span.hi - span.lo;
      if (guard === 0 && !span.live && span.hi - to < page)
        this.run(() => this.loadNewer(q.chatId, chat.ranges[span.i][1]));
      if (span.start)
        return;
      let short;
      if (!q.anchor)
        short = have < q.limit;
      else {
        const reached = have > 0 && all[span.lo].sort <= q.anchor.sort;
        short = !reached || q.anchor.side !== "start" && from === span.lo && to - from < q.limit;
      }
      const far = q.anchor && have > 0 && all[span.lo].sort > q.anchor.sort;
      if (short) {
        await this.ensureHistory(q.chatId, q.anchor?.sort, have + (far ? 200 : page), far ? 200 : undefined);
        continue;
      }
      const lead = from - span.lo, want = page * HISTORY_AHEAD;
      if (lead < want)
        this.run(() => this.ensureHistory(q.chatId, q.anchor?.sort, have + want - lead));
      return;
    }
  }
  ensureHistory(chatId, sort, limit, pageSize) {
    return this.loadHistory(chatId, pageSize ?? this.cfg.historyPage ?? 50, () => {
      const chat = this.store.chats.get(chatId);
      if (!chat)
        return null;
      const span = feedSpan(chat, this.store.chatMessages(chatId), sort);
      const verify = span.live && span.i >= 0 && chat.seed != null && chat.ranges[span.i][0] < chat.seed;
      if (!verify && (span.hi - span.lo >= limit || span.start))
        return null;
      return { before: verify ? chat.seed : span.i >= 0 ? chat.ranges[span.i][0] : null };
    });
  }
  loadNewer(chatId, sort) {
    if (this.newerLoads.has(chatId))
      return this.newerLoads.get(chatId);
    const ranges = this.store.chats.get(chatId)?.ranges ?? [];
    const i = rangeAt(ranges, sort);
    if (i < 0 || i === ranges.length - 1)
      return Promise.resolve();
    const after = ranges[i][1], page = this.cfg.historyPage ?? 50, gen = this.store.resetGen;
    const p = (async () => {
      const res = await this.http(`/chats/${chatId}/messages?limit=${page}&after=${after}`);
      this.store.applyNewerHistory(chatId, res.messages, res.hasMore, after, gen);
      await this.store.flush();
      this.changed();
    })().finally(() => this.newerLoads.delete(chatId));
    this.newerLoads.set(chatId, p);
    return p;
  }
  newerLoads = new Map;
  async ensureThreadWindow(q) {
    const page = this.cfg.historyPage ?? 50;
    for (let guard = 0;guard < 50; guard++) {
      if (!this.store.chats.has(q.chatId) && !this.online)
        return;
      const { all, span, from, to } = threadView(this.store, q);
      if (span.start)
        return;
      const have = span.hi - span.lo;
      const short = !q.anchor ? have < q.limit : have === 0 || all[span.lo].sort > q.anchor.sort || q.anchor.side !== "start" && from === span.lo && to - from < q.limit;
      const before = () => {
        const t = this.store.threadRanges(q.chatId, q.threadId);
        return span.i >= 0 && t ? t.ranges[span.i][0] : null;
      };
      if (short) {
        if (!await this.loadThreadPage(q.chatId, q.threadId, before))
          return;
        continue;
      }
      if (from - span.lo < page)
        this.run(() => this.loadThreadPage(q.chatId, q.threadId, before));
      return;
    }
  }
  loadThreadPage(chatId, threadId, before) {
    const k = chatId + ":" + threadId, running = this.threadLoads.get(k);
    if (running)
      return running.then(() => 0);
    const at = before(this.store.threadRanges(chatId, threadId));
    if (at === undefined)
      return Promise.resolve(0);
    const page = this.cfg.historyPage ?? 50, gen = this.store.resetGen;
    const p = (async () => {
      const res = await this.http(`/chats/${chatId}/threads/${threadId}/messages?limit=${page}${at ? `&before=${at}` : ""}`);
      if (gen !== this.store.resetGen)
        return 0;
      this.store.applyThreadPage(chatId, threadId, res.header, res.messages, res.hasMore, at, "older", gen, res.guest ?? null);
      await this.store.flush();
      this.changed();
      return res.messages.length;
    })().finally(() => this.threadLoads.delete(k));
    this.threadLoads.set(k, p);
    return p;
  }
  threadLoads = new Map;
  watchingThreads = new Set;
  refusedThreads = new Set;
  syncThreadWatches() {
    if (!this.online || this.closed)
      return;
    const want = new Set;
    for (const w of this.watchers.values())
      if (w.q.kind === "thread" && this.store.isGuest(w.q.chatId))
        want.add(w.q.chatId + ":" + w.q.threadId);
    for (const k of want) {
      if (this.watchingThreads.has(k) || this.refusedThreads.has(k))
        continue;
      this.watchingThreads.add(k);
      const [chatId, threadId] = k.split(":").map(Number);
      this.request({ op: "watchThread", reqId: "", chatId, threadId }).then(() => {
        if (!this.watchingThreads.has(k))
          return;
        this.store.guestWatch(chatId, threadId, true);
        this.run(() => this.catchUpThread(chatId, threadId));
      }).catch((e) => {
        if (this.watchingThreads.delete(k) && e?.code !== "offline" && !e?.retry)
          this.refusedThreads.add(k);
      });
    }
    for (const k of [...this.watchingThreads]) {
      if (want.has(k))
        continue;
      this.watchingThreads.delete(k);
      const [chatId, threadId] = k.split(":").map(Number);
      this.store.guestWatch(chatId, threadId, false);
      this.request({ op: "unwatchThread", reqId: "", chatId, threadId }).catch(() => {});
      if (!this.store.isGuest(chatId) && [...this.watchers.values()].some((w) => w.q.kind === "thread" && w.q.chatId === chatId && w.q.threadId === threadId))
        this.run(() => this.catchUpThread(chatId, threadId));
    }
  }
  async catchUpThread(chatId, threadId) {
    const page = this.cfg.historyPage ?? 50;
    for (let i = 0;i < 10; i++) {
      const t = this.store.threadRanges(chatId, threadId);
      const last = t?.ranges[t.ranges.length - 1]?.[1];
      if (last == null) {
        await this.loadThreadPage(chatId, threadId, () => null);
        return;
      }
      const gen = this.store.resetGen;
      const res = await this.http(`/chats/${chatId}/threads/${threadId}/messages?limit=${page}&after=${last}`);
      if (gen !== this.store.resetGen)
        return;
      this.store.applyThreadPage(chatId, threadId, res.header, res.messages, res.hasMore, last, "newer", gen, res.guest ?? null);
      await this.store.flush();
      this.changed();
      if (!res.hasMore)
        return;
    }
    await this.loadThreadPage(chatId, threadId, () => null);
  }
  fetchPosts() {
    if (!this.online || !this.postWants.size)
      return;
    const wants = [...this.postWants.entries()];
    this.postWants.clear();
    for (const [chatId, ids] of wants) {
      this.run(async () => {
        const asked = [...ids].slice(0, 100);
        const res = await this.http(`/chats/${chatId}/messages?ids=${asked.join(",")}`);
        const withReplies = new Set(res.messages.filter((m) => m.replies).map((m) => m.id));
        for (const id of asked)
          if (!withReplies.has(id))
            this.postsNoReplies.add(chatId + ":" + id);
        this.store.addLoose(chatId, res.messages);
        await this.store.flush();
        this.changed();
      });
    }
  }
  postWants = new Map;
  postsNoReplies = new Set;
  loadHistory(chatId, page, next) {
    const running = this.historyLoads.get(chatId);
    if (running)
      return running.then(() => this.loadHistory(chatId, page, next));
    if (!next())
      return Promise.resolve();
    const p = (async () => {
      for (let n = next();n; n = next()) {
        const { before } = n, gen = this.store.resetGen;
        const res = await this.http(`/chats/${chatId}/messages?limit=${page}${before ? `&before=${before}` : ""}`);
        if (gen !== this.store.resetGen)
          break;
        this.store.applyHistory(chatId, res.messages, res.hasMore, before, gen);
        await this.store.flush();
        this.changed();
        if (!res.messages.length)
          break;
      }
    })().finally(() => this.historyLoads.delete(chatId));
    this.historyLoads.set(chatId, p);
    return p;
  }
  evictTimer = null;
  evicting = null;
  lastEvict = 0;
  scheduleEvict() {
    if (this.closed || this.evictTimer || this.evicting || Date.now() - this.lastEvict < (this.cfg.evictEveryMs ?? 10 * 60000))
      return;
    this.evictTimer = setTimeout(() => {
      this.evictTimer = null;
      if (this.closed)
        return;
      if (this.syncing || this.holding || this.busy > 0 || this.pending.size > 0 || this.historyLoads.size > 0) {
        this.scheduleEvict();
        return;
      }
      this.run(() => this.evict());
    }, this.cfg.evictDelayMs ?? 5000);
  }
  evict(limits = EVICT_LIMITS, opts = {}) {
    if (this.evicting)
      return this.evicting;
    this.lastEvict = Date.now();
    const t0 = Date.now();
    const forget = (id) => {
      this.usersAsked.delete(id);
      this.lists.forgetUser(id);
    };
    const p = evict(this.store, this.db, () => this.evictKeep(), limits, { closed: () => this.closed, onUserEvicted: forget, ...opts }).then((st) => {
      this.dev.log.record("engine", "evict", st, undefined, Date.now() - t0);
      this.changed();
      return st;
    }).finally(() => {
      this.evicting = null;
      this.lastEvict = Date.now();
    });
    this.evicting = p;
    return p;
  }
  evictKeep() {
    const keep = { windows: new Map, people: new Set(this.contacts.view().keys()), members: new Set, busy: new Set };
    for (const id of [...this.historyLoads.keys(), ...this.newerLoads.keys(), ...this.chatLoads.keys()])
      keep.busy.add(id);
    for (const k of this.savedLoads.keys())
      keep.busy.add(parseInt(k, 10));
    for (const id of this.media.busyChats())
      keep.busy.add(id);
    const win = (chatId) => {
      let s = keep.windows.get(chatId);
      if (!s) {
        s = new Set;
        keep.windows.set(chatId, s);
      }
      return s;
    };
    for (const w of this.watchers.values()) {
      const q = w.q;
      if (q.kind === "messages") {
        if (w.gated || !this.store.isLoaded(q.chatId))
          keep.busy.add(q.chatId);
        const set = win(q.chatId), all = this.store.chatMessages(q.chatId);
        const span = feedSpan(this.store.chats.get(q.chatId), all, q.anchor?.sort);
        const { from, to } = messageWindow(all, q, span.lo, span.hi);
        const add = (m) => {
          set.add(m.key);
          const r = m.replyToId != null ? this.store.messageById(q.chatId, m.replyToId) : undefined;
          if (r)
            set.add(r.key);
        };
        for (let k = from;k < to; k++)
          add(all[k]);
        for (const k of w.prev?.order ?? []) {
          const m = this.store.loadedMessage(q.chatId, k);
          if (m)
            add(m);
        }
      } else if (q.kind === "thread") {
        if (w.gated || !this.store.isLoaded(q.chatId) || this.threadLoads.has(q.chatId + ":" + q.threadId))
          keep.busy.add(q.chatId);
        const set = win(q.chatId), { all, from, to } = threadView(this.store, q);
        const h = this.store.messageById(q.chatId, q.threadId);
        if (h)
          set.add(h.key);
        for (let k = from;k < to; k++) {
          set.add(all[k].key);
          const r = all[k].replyToId != null ? this.store.messageById(q.chatId, all[k].replyToId) : undefined;
          if (r)
            set.add(r.key);
        }
      } else if (q.kind === "savedFeed") {
        if (w.gated || !this.store.isLoaded(q.chatId))
          keep.busy.add(q.chatId);
        const set = win(q.chatId), { all, from, to } = savedView(this.store, q);
        for (let k = from;k < to; k++) {
          set.add(all[k].key);
          const r = all[k].replyToId != null ? this.store.messageById(q.chatId, all[k].replyToId) : undefined;
          if (r)
            set.add(r.key);
        }
      } else if (q.kind === "media") {
        const set = win(q.chatId);
        for (const m of tabMessages(this.store, q.chatId, q.tab, q.savedPeer).slice(-q.limit))
          set.add(m.key);
      } else if (q.kind === "people")
        for (const id of q.ids)
          keep.people.add(id);
      else if (q.kind === "user" || q.kind === "presence" || q.kind === "profileMusic" || q.kind === "profilePhotos")
        keep.people.add(q.userId);
      else if (q.kind === "members")
        keep.members.add(q.chatId);
    }
    return keep;
  }
  async http(path, init) {
    const headers = init?.body ? { ...this.cfg.headers, "content-type": "application/json" } : this.cfg.headers;
    const res = await this.dev.fetch(this.cfg.httpBase + path, { headers, credentials: "include", ...init ?? {} });
    if (this.session.unauthorized(res.status))
      throw { code: "offline", retry: false };
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${path}`);
    return await res.json();
  }
  run(fn) {
    this.busy++;
    fn().catch((err) => {
      if (!(err && err.code === "offline")) {
        console.error("sync engine:", err);
        this.dev.log.error("engine", err);
      }
    }).finally(() => {
      this.busy--;
    });
  }
  async whenIdle(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    const busy = () => this.syncing || this.busy > 0 || this.pending.size > 0 || this.frameTimer !== null || this.readTimer !== null || this.transport.wanted && !this.ready || this.ready && [...this.store.outbox.values()].some((o) => !o.failed) || this.ready && this.store.pendingReads.size > 0 || this.ops.sending;
    while (busy()) {
      if (Date.now() > end) {
        throw new Error("engine did not become idle: " + JSON.stringify({
          syncing: this.syncing,
          busy: this.busy,
          pending: this.pending.size,
          frame: this.frameTimer !== null,
          read: this.readTimer !== null,
          wanted: this.transport.wanted,
          ready: this.ready,
          outbox: this.store.outbox.size,
          reads: this.store.pendingReads.size
        }));
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export { Engine };

//# debugId=52AEA19DA9AF528964756E2164756E21
//# sourceMappingURL=main-qy2821z4.js.map
