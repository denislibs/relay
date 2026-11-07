// packages/protocol/src/links.ts
var LINK_SERVICES = {
  linkedin: { title: "LinkedIn", host: "linkedin.com", path: "/in/", re: /^[A-Za-z0-9-]{3,100}$/ },
  github: { title: "GitHub", host: "github.com", path: "/", re: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/ },
  instagram: { title: "Instagram", host: "instagram.com", path: "/", re: /^[A-Za-z0-9._]{1,30}$/ },
  x: { title: "X", host: "x.com", path: "/", re: /^[A-Za-z0-9_]{1,15}$/ },
  youtube: { title: "YouTube", host: "youtube.com", path: "/@", re: /^[A-Za-z0-9._-]{3,30}$/ },
  tiktok: { title: "TikTok", host: "tiktok.com", path: "/@", re: /^[A-Za-z0-9._]{2,24}$/ },
  telegram: { title: "Telegram", host: "t.me", path: "/", re: /^[A-Za-z][A-Za-z0-9_]{4,31}$/ },
  dribbble: { title: "Dribbble", host: "dribbble.com", path: "/", re: /^[A-Za-z0-9_-]{2,40}$/ },
  behance: { title: "Behance", host: "behance.net", path: "/", re: /^[A-Za-z0-9_-]{3,40}$/ }
};
var LINK_SERVICE_IDS = Object.keys(LINK_SERVICES);
var MAX_LINKS = 10;
var linkPrefix = (s) => LINK_SERVICES[s].host + LINK_SERVICES[s].path;
var linkUrl = (l) => "https://" + linkPrefix(l.service) + encodeURIComponent(l.handle);
var linkLabel = (l) => linkPrefix(l.service) + l.handle;
function parseLinkHandle(service, raw) {
  const spec = LINK_SERVICES[service];
  let s = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?([^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(s);
  if (url && /\./.test(url[1]) && (/^https?:\/\//i.test(s) || url[2] !== undefined)) {
    if (url[1].toLowerCase() !== spec.host)
      return null;
    const path = (url[2] ?? "/").replace(/\/+$/, "");
    if (!path.toLowerCase().startsWith(spec.path.replace(/\/$/, "").toLowerCase() || "/"))
      return null;
    s = path.replace(new RegExp("^" + spec.path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "i"), "");
  }
  s = s.replace(/^@/, "");
  return spec.re.test(s) ? s : null;
}
// packages/protocol/src/emoji.ts
var FE0F = /️/gu;
var TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;
function emojiKey(s) {
  const out = s.replace(FE0F, "");
  const tones = out.match(TONE);
  if (!tones)
    return out;
  return tones.every((t) => t === tones[0]) ? out.replace(TONE, "") : out;
}
var RGI = /^\p{RGI_Emoji}$/v;
var isEmoji = (g) => RGI.test(g) || RGI.test(g + "️");
var HAS_LETTER = /\p{L}/u;
var MAYBE_EMOJI = /[©®‼-㊙️\u{1F000}-\u{1FAFF}\u{E0020}-\u{E007F}]/u;
var EMOJI_ONLY_MAX = 100;
var EMOJI_ONLY_BODY_MAX = 800;
var segmenter = null;
function warmEmoji() {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  isEmoji("\uD83D\uDE00");
}
function emojiOnly(body, entities) {
  if (!body || body.length > EMOJI_ONLY_BODY_MAX || entities && entities.length || HAS_LETTER.test(body) || !MAYBE_EMOJI.test(body))
    return null;
  const lines = body.split(`
`).map((l) => l.replace(/\s+/g, "")).filter((l) => l.length);
  if (!lines.length)
    return null;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const keys = [];
  let widest = 0;
  for (const line of lines) {
    let n = 0;
    for (const { segment } of segmenter.segment(line)) {
      if (!isEmoji(segment))
        return null;
      keys.push(emojiKey(segment));
      n++;
    }
    if (n > widest)
      widest = n;
  }
  if (keys.length > EMOJI_ONLY_MAX)
    return null;
  return { count: Math.max(lines.length, widest), keys };
}
// packages/protocol/src/folders.ts
var FOLDER_LIMITS = { folders: 10, chats: 200, title: 16, emoji: 16 };
var FOLDER_COLORS = 7;
var FOLDER_MIN_ID = 2;
var FOLDER_MAX_ID = 1e6;
function graphemes(s) {
  const Seg = Intl.Segmenter;
  if (Seg) {
    let n = 0;
    for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(s))
      n++;
    return n;
  }
  return [...s].length;
}
var ids = (v) => {
  if (!Array.isArray(v))
    return [];
  const out = [];
  const seen = new Set;
  for (const x of v)
    if (typeof x === "number" && Number.isSafeInteger(x) && x > 0 && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  return out;
};
function normalizeFolder(v) {
  const f = v;
  if (!f || typeof f !== "object")
    return null;
  const id = f.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < FOLDER_MIN_ID || id > FOLDER_MAX_ID)
    return null;
  const include = ids(f.include);
  const inc = new Set(include);
  const emoji = typeof f.emoji === "string" && f.emoji.trim() ? f.emoji.trim() : null;
  const color = typeof f.color === "number" && Number.isInteger(f.color) && f.color >= 0 && f.color < FOLDER_COLORS ? f.color : null;
  return {
    id,
    title: typeof f.title === "string" ? f.title.replace(/\s+/g, " ").trim() : "",
    emoji,
    color,
    include,
    exclude: ids(f.exclude).filter((x) => !inc.has(x)),
    contacts: f.contacts === true,
    nonContacts: f.nonContacts === true,
    groups: f.groups === true,
    excludeMuted: f.excludeMuted === true,
    excludeRead: f.excludeRead === true
  };
}
function folderError(f) {
  const n = graphemes(f.title);
  if (n < 1 || n > FOLDER_LIMITS.title)
    return "folder_title";
  if (f.emoji !== null && (graphemes(f.emoji) !== 1 || f.emoji.length > FOLDER_LIMITS.emoji))
    return "folder_emoji";
  if (f.include.length > FOLDER_LIMITS.chats || f.exclude.length > FOLDER_LIMITS.chats)
    return "folder_too_many_chats";
  if (!f.include.length && !f.contacts && !f.nonContacts && !f.groups)
    return "folder_empty";
  return null;
}
function normalizeFolders(v) {
  if (!Array.isArray(v))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of v) {
    const f = normalizeFolder(raw);
    if (f && !seen.has(f.id) && out.length < FOLDER_LIMITS.folders) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}
var nextFolderId = (folders) => folders.reduce((m, f) => Math.max(m, f.id + 1), FOLDER_MIN_ID);
// packages/protocol/src/groups.ts
var MEMBER_RIGHTS = ["text", "photos", "videos", "files", "music", "voice", "round", "stickers", "links", "react", "invite", "pin", "info"];
var MEDIA_RIGHTS = ["photos", "videos", "files", "music", "voice", "round", "stickers", "links"];
var ANY_ADMIN_RIGHTS = ["info", "post", "edit", "delete", "ban", "invite", "pin", "calls", "addAdmins"];
var ADMIN_RIGHTS_BY_KIND = {
  group: ["info", "delete", "ban", "invite", "pin", "calls", "addAdmins"],
  channel: ["info", "post", "edit", "delete", "ban", "invite", "addAdmins"]
};
var ADMIN_RIGHTS = ADMIN_RIGHTS_BY_KIND.group;
var SLOW_MODES = [0, 10, 30, 60, 300, 900, 3600];
var GROUP_ABOUT_MAX = 255;
var RANK_MAX = 16;
var INVITE_USAGE_MAX = 99999;
var allAdminRights = (kind = "group") => Object.fromEntries(ANY_ADMIN_RIGHTS.map((r) => [r, ADMIN_RIGHTS_BY_KIND[kind].includes(r)]));
var noAdminRights = (_kind = "group") => Object.fromEntries(ANY_ADMIN_RIGHTS.map((r) => [r, false]));
var hasMedia = (r) => MEDIA_RIGHTS.some((k) => r[k]);
var rightsCount = (r) => MEMBER_RIGHTS.filter((k) => r[k]).length;
function rightForKind(kind, mime) {
  switch (kind) {
    case "photo":
      return "photos";
    case "video":
      return "videos";
    case "voice":
      return "voice";
    case "round":
      return "round";
    case "audio":
      return "music";
    case "sticker":
      return "stickers";
    case "file":
      return mime?.startsWith("video/") ? "videos" : "files";
    default:
      return "text";
  }
}
var isAdminRole = (role) => role === "owner" || role === "admin";
// packages/protocol/src/adminLog.ts
var ADMIN_LOG_GROUPS = {
  members: ["member_added", "member_joined", "member_left", "member_banned", "member_unbanned", "member_restricted", "member_unrestricted", "request_approved", "request_declined"],
  admins: ["admin_promoted", "admin_edited", "admin_demoted", "admin_rank_changed", "owner_transferred"],
  settings: ["title_changed", "about_changed", "photo_changed", "photo_removed", "username_changed", "signatures_toggled", "protected_toggled", "theme_changed", "auto_delete_changed", "slow_mode_changed", "history_toggled", "join_approval_toggled", "join_to_send_toggled", "linked_chat_changed", "reactions_changed", "default_rights_changed"],
  messages: ["message_deleted", "message_edited", "message_pinned", "message_unpinned", "all_unpinned", "poll_closed"],
  invites: ["invite_created", "invite_edited", "invite_revoked", "invite_deleted"]
};
var ADMIN_LOG_ACTIONS = Object.values(ADMIN_LOG_GROUPS).flat();
var ADMIN_LOG_LABELS = {
  member_added: "Добавление участника",
  member_joined: "Вступление",
  member_left: "Выход",
  member_banned: "Исключение",
  member_unbanned: "Снятие исключения",
  member_restricted: "Ограничение участника",
  member_unrestricted: "Снятие ограничений",
  request_approved: "Заявка одобрена",
  request_declined: "Заявка отклонена",
  admin_promoted: "Назначение администратора",
  admin_edited: "Изменение прав администратора",
  admin_demoted: "Снятие администратора",
  admin_rank_changed: "Изменение звания",
  owner_transferred: "Передача владения",
  title_changed: "Название",
  about_changed: "Описание",
  photo_changed: "Фото",
  photo_removed: "Удаление фото",
  username_changed: "Адрес",
  signatures_toggled: "Подписи постов",
  protected_toggled: "Защита содержимого",
  theme_changed: "Тема чата",
  auto_delete_changed: "Автоудаление",
  slow_mode_changed: "Медленный режим",
  history_toggled: "История для новых участников",
  join_approval_toggled: "Вступление по заявке",
  join_to_send_toggled: "Только участники пишут",
  linked_chat_changed: "Группа обсуждения",
  reactions_changed: "Реакции",
  default_rights_changed: "Права участников",
  message_deleted: "Удаление сообщения",
  message_edited: "Правка сообщения",
  message_pinned: "Закрепление",
  message_unpinned: "Открепление",
  all_unpinned: "Открепление всех",
  poll_closed: "Закрытие опроса",
  invite_created: "Создание ссылки",
  invite_edited: "Изменение ссылки",
  invite_revoked: "Отзыв ссылки",
  invite_deleted: "Удаление ссылки"
};
// packages/protocol/src/special.ts
var DICE_FACES = { "\uD83C\uDFB2": 6, "\uD83C\uDFAF": 6, "\uD83C\uDFC0": 5, "⚽": 5, "\uD83C\uDFB3": 6, "\uD83C\uDFB0": 64 };
var isDiceEmoji = (s) => typeof s === "string" && Object.prototype.hasOwnProperty.call(DICE_FACES, s);
// packages/protocol/src/blocks.ts
function blocksText(blocks) {
  const lines = [];
  const walk = (list, indent) => {
    for (const b of list) {
      switch (b.type) {
        case "p":
        case "h":
          lines.push(indent + b.text);
          break;
        case "code":
          lines.push(b.text);
          break;
        case "hr":
          lines.push("———");
          break;
        case "quote":
          walk(b.blocks, indent);
          break;
        case "ul":
        case "ol":
          b.items.forEach((it, i) => {
            const mark = b.type === "ol" ? `${(b.start ?? 1) + i}. ` : "• ";
            const sub = [];
            const save = lines.length;
            walk(it, indent + "  ");
            const got = lines.splice(save).map((l) => l.trimStart());
            sub.push(...got);
            if (sub.length) {
              lines.push(indent + mark + sub[0]);
              for (const l of sub.slice(1))
                lines.push(indent + "  " + l);
            }
          });
          break;
      }
    }
  };
  walk(blocks, "");
  return lines.join(`
`).trim();
}
function blocksToText(blocks) {
  let text = "";
  const entities = [];
  for (let i = 0;i < blocks.length; i++) {
    const b = blocks[i];
    if (i)
      text += `
`;
    if (b.type === "p") {
      for (const e of b.entities ?? [])
        entities.push({ ...e, offset: e.offset + text.length });
      text += b.text;
    } else if (b.type === "code") {
      if (b.text)
        entities.push({ type: "pre", offset: text.length, length: b.text.length });
      text += b.text;
    } else
      return null;
  }
  return { text, entities };
}
function textToBlocks(text, entities = []) {
  const blocks = [];
  const pres = entities.filter((e) => e.type === "pre").sort((a, b) => a.offset - b.offset);
  const rest = entities.filter((e) => e.type !== "pre");
  const para = (from, to) => {
    let at = from;
    for (const line of text.slice(from, to).split(`
`)) {
      const start = at, end = at + line.length;
      const ents = rest.filter((e) => e.offset < end && e.offset + e.length > start).map((e) => {
        const s = Math.max(e.offset, start), f = Math.min(e.offset + e.length, end);
        return { ...e, offset: s - start, length: f - s };
      }).filter((e) => e.length > 0);
      blocks.push(ents.length ? { type: "p", text: line, entities: ents } : { type: "p", text: line });
      at = end + 1;
    }
  };
  let pos = 0;
  for (const p of pres) {
    if (p.offset > pos)
      para(pos, Math.max(pos, p.offset - (text[p.offset - 1] === `
` ? 1 : 0)));
    blocks.push({ type: "code", text: text.slice(p.offset, p.offset + p.length) });
    pos = p.offset + p.length + (text[p.offset + p.length] === `
` ? 1 : 0);
  }
  if (pos < text.length || !blocks.length)
    para(pos, text.length);
  return blocks;
}
// packages/protocol/src/fileCrypto.ts
var FILE_MAGIC = "RLF1";
var FILE_HEADER = 24;
var FILE_CHUNK = 512 * 1024;
var FILE_TAG = 16;
var enc = new TextEncoder;
var aadFor = (i, last) => enc.encode(`relay-file|${i}|${last ? 1 : 0}`);
var iv = (base, i) => {
  const v = new Uint8Array(12);
  v.set(base, 0);
  new DataView(v.buffer).setUint32(8, i);
  return v;
};
var chunkCount = (size, chunk = FILE_CHUNK) => Math.max(1, Math.ceil(size / chunk));
var encryptedSize = (size, chunk = FILE_CHUNK) => FILE_HEADER + size + FILE_TAG * chunkCount(size, chunk);
function writeHeader(h) {
  const out = new Uint8Array(FILE_HEADER);
  out.set(enc.encode(FILE_MAGIC), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, h.chunk);
  dv.setBigUint64(8, BigInt(h.size));
  out.set(h.base, 16);
  return out;
}
function readHeader(b) {
  if (b.length < FILE_HEADER || new TextDecoder().decode(b.subarray(0, 4)) !== FILE_MAGIC)
    return null;
  const dv = new DataView(b.buffer, b.byteOffset, FILE_HEADER);
  return { chunk: dv.getUint32(4), size: Number(dv.getBigUint64(8)), base: b.slice(16, 24) };
}
var importFileKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
var newFileKey = () => crypto.getRandomValues(new Uint8Array(32));
var newNonceBase = () => crypto.getRandomValues(new Uint8Array(8));
async function sealChunk(key, h, i, plain) {
  const last = i === chunkCount(h.size, h.chunk) - 1;
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(h.base, i), additionalData: aadFor(i, last) }, key, plain));
}
async function openChunk(key, h, i, sealed) {
  const last = i === chunkCount(h.size, h.chunk) - 1;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(h.base, i), additionalData: aadFor(i, last) }, key, sealed));
  } catch {
    throw new Error(`file chunk ${i}: wrong key or damaged data`);
  }
}
function sealedRange(h, i) {
  const start = FILE_HEADER + i * (h.chunk + FILE_TAG);
  const plainLen = Math.min(h.chunk, h.size - i * h.chunk);
  return [start, start + Math.max(0, plainLen) + FILE_TAG];
}
function sealedSource(file, key, h) {
  const size = encryptedSize(h.size, h.chunk);
  const head = writeHeader(h);
  const piece = async (i) => sealChunk(key, h, i, new Uint8Array(await file.slice(i * h.chunk, Math.min(h.size, (i + 1) * h.chunk)).arrayBuffer()));
  return {
    size,
    async slice(a, b) {
      b = Math.min(b, size);
      const parts = [];
      if (a < FILE_HEADER)
        parts.push(head.slice(a, Math.min(b, FILE_HEADER)));
      const per = h.chunk + FILE_TAG;
      const from = Math.max(0, Math.floor((Math.max(a, FILE_HEADER) - FILE_HEADER) / per));
      for (let i = from;i < chunkCount(h.size, h.chunk); i++) {
        const [s, e] = sealedRange(h, i);
        if (s >= b)
          break;
        const c = await piece(i);
        parts.push(c.slice(Math.max(0, a - s), Math.min(c.length, b - s)));
        if (e >= b)
          break;
      }
      return new Blob(parts);
    }
  };
}
async function openFile(sealed, key, type = "") {
  const h = readHeader(new Uint8Array(await sealed.slice(0, FILE_HEADER).arrayBuffer()));
  if (!h)
    return sealed;
  const out = [];
  for (let i = 0;i < chunkCount(h.size, h.chunk); i++) {
    const [s, e] = sealedRange(h, i);
    out.push(await openChunk(key, h, i, new Uint8Array(await sealed.slice(s, e).arrayBuffer())));
  }
  return new Blob(out, { type });
}
var toBase64 = (b) => {
  let s = "";
  for (const x of b)
    s += String.fromCharCode(x);
  return btoa(s);
};
var fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// packages/protocol/src/mentions.ts
var USERNAME_MIN = 5;
var USERNAME_MAX = 32;
var USERNAME = new RegExp(`^[a-z][a-z0-9_]{${USERNAME_MIN - 1},${USERNAME_MAX - 1}}$`);
var MENTION_RE = new RegExp(`(?<![\\p{L}\\p{N}_@./])@([A-Za-z][A-Za-z0-9_]{${USERNAME_MIN - 1},${USERNAME_MAX - 1}})(?![\\p{L}\\p{N}_])`, "gu");
var SKIP = new Set(["code", "pre", "link"]);
// packages/protocol/src/calls.ts
var CALL_PING_MS = 20000;
// packages/protocol/src/groupCalls.ts
var GROUP_CALL_PING_MS = 20000;
var GROUP_CALL_TITLE_MAX = 64;
// packages/protocol/src/index.ts
var SCHEDULED_LIMIT = 100;
var SCHEDULE_MAX_MS = 365 * 24 * 3600000;
var AUTO_DELETE_MIN_SEC = 3600;
var AUTO_DELETE_MAX_SEC = 365 * 24 * 3600;
var SAVED_GIFS_LIMIT = 200;
var GIF_MAX_BYTES = 40 * 1024 * 1024;
var SAVED_TITLE = "Избранное";
var RECENT_STICKERS_LIMIT = 20;
var FAVED_STICKERS_LIMIT = 5;
var SAVED_NOTES = "me";
var SAVED_HIDDEN = "hidden";
function savedPeerRule(fwd, savedChatId, src) {
  if (!fwd || Number(fwd.chatId) === Number(savedChatId))
    return SAVED_NOTES;
  if (!src || src.gone)
    return SAVED_HIDDEN;
  if (src.kind === "direct")
    return src.peerId != null ? "u" + src.peerId : SAVED_HIDDEN;
  return "c" + fwd.chatId;
}
var DATE_FORMAT = /^(r|w?[dD]?[tT]?)$/;
var ENTITY_TYPES = ["bold", "italic", "underline", "strike", "spoiler", "code", "pre", "link", "date", "blockquote"];
var MAX_ENTITIES = 100;
var EMOJI_FX_MAX = 10;
var EMOJI_FX_WINDOW_S = 10;
function entityUrl(raw) {
  if (typeof raw !== "string")
    return null;
  const s = raw.trim();
  if (!s || s.length > 2048 || /\s/.test(s))
    return null;
  return /^(https?:\/\/[^/?#\s]+|mailto:[^@\s]+@)/i.test(s) ? s : null;
}
async function draftHash(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function normalizeEntities(text, raw) {
  if (!Array.isArray(raw))
    return [];
  const by = new Map;
  for (const e of raw.slice(0, MAX_ENTITIES * 2)) {
    if (!e || typeof e !== "object")
      continue;
    const { type, offset, length } = e;
    if (!ENTITY_TYPES.includes(type) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length))
      continue;
    const s = Math.max(0, offset), end = Math.min(text.length, offset + length);
    if (end <= s)
      continue;
    const url = type === "link" ? entityUrl(e.url) : undefined;
    if (type === "link" && !url)
      continue;
    const date = type === "date" ? e.date : undefined;
    const format = type === "date" ? e.format ?? "" : undefined;
    if (type === "date" && (!Number.isSafeInteger(date) || date < 0 || date > 4102444800 || typeof format !== "string" || !DATE_FORMAT.test(format)))
      continue;
    const key = type === "link" ? "link " + url : type === "date" ? "date " + date + " " + format : type;
    const list = by.get(key) ?? [];
    list.push(type === "blockquote" ? { type: "blockquote", offset: s, length: end - s, ...e.collapsed === true ? { collapsed: true } : {} } : url ? { type: "link", offset: s, length: end - s, url } : type === "date" ? { type: "date", offset: s, length: end - s, date, ...format ? { format } : {} } : { type, offset: s, length: end - s });
    by.set(key, list);
  }
  const out = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.offset - b.offset);
    let cur = null;
    for (const e of list) {
      if (cur && e.offset <= cur.offset + cur.length) {
        cur.length = Math.max(cur.length, e.offset + e.length - cur.offset);
        if (cur.collapsed && !e.collapsed)
          delete cur.collapsed;
      } else {
        cur = { ...e };
        out.push(cur);
      }
    }
  }
  const pre = out.filter((e) => e.type === "pre");
  const kept = pre.length ? out.filter((e) => e.type !== "blockquote" || !pre.some((p) => p.offset < e.offset + e.length && e.offset < p.offset + p.length)) : out;
  return kept.sort((a, b) => a.offset - b.offset || b.length - a.length).slice(0, MAX_ENTITIES);
}
var QUOTE_MAX = 1024;
var QUOTE_TYPES = new Set(["bold", "italic", "underline", "strike", "spoiler", "code", "link"]);
function locateQuote(body, text, hint) {
  if (!text)
    return -1;
  if (body.startsWith(text, hint))
    return hint;
  let best = -1;
  for (let at = body.indexOf(text);at >= 0; at = body.indexOf(text, at + 1)) {
    if (best < 0 || Math.abs(at - hint) < Math.abs(best - hint))
      best = at;
  }
  return best;
}
function clipQuoteEntities(body, entities, offset, length) {
  const text = body.slice(offset, offset + length), cut = [];
  for (const e of entities ?? []) {
    if (!QUOTE_TYPES.has(e.type))
      continue;
    const s = Math.max(e.offset, offset), end = Math.min(e.offset + e.length, offset + length);
    if (end > s)
      cut.push({ ...e, offset: s - offset, length: end - s });
  }
  return normalizeEntities(text, cut);
}
function makeQuote(body, entities, selected, hint) {
  const lead = selected.length - selected.trimStart().length;
  let text = selected.trim();
  if (!text)
    return null;
  const at = locateQuote(body, text, hint + lead);
  if (at < 0)
    return null;
  if (text.length > QUOTE_MAX) {
    const c = text.charCodeAt(QUOTE_MAX - 1);
    text = text.slice(0, c >= 55296 && c <= 56319 ? QUOTE_MAX - 1 : QUOTE_MAX).trimEnd();
  }
  const list = clipQuoteEntities(body, entities, at, text.length);
  return { text, offset: at, ...list.length ? { entities: list } : {} };
}
var MEDIA_TABS = ["media", "file", "link", "audio", "voice"];
var isVideoMedia = (m) => m.kind === "video" || m.kind === "file" && (m.attachment?.mime?.startsWith("video/") ?? false);
function mediaTabs(m) {
  const video = m.attachment?.mime?.startsWith("video/") ?? false;
  const tabs = [];
  if (m.kind === "photo" || m.kind === "video" || m.kind === "file" && video)
    tabs.push("media");
  if (m.kind === "file" && !video)
    tabs.push("file");
  if (m.kind === "audio")
    tabs.push("audio");
  if (m.kind === "voice" || m.kind === "round")
    tabs.push("voice");
  if (!m.service && (/(https?:\/\/|www\.)\S/i.test(m.body) || (m.entities?.some((e) => e.type === "link") ?? false)))
    tabs.push("link");
  return tabs;
}
var MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
var NO_PREVIEW = "Новое сообщение";
var PRIVACY_KEYS = ["phone", "phoneDiscovery", "lastSeen", "bio", "birthday", "calls", "p2p"];
var defaultPrivacyRule = (key) => ({ mode: key === "phone" || key === "p2p" ? "contacts" : "everyone", allow: [], deny: [] });
var defaultPrivacy = () => ({
  phone: defaultPrivacyRule("phone"),
  phoneDiscovery: defaultPrivacyRule("phoneDiscovery"),
  lastSeen: defaultPrivacyRule("lastSeen"),
  bio: defaultPrivacyRule("bio"),
  birthday: defaultPrivacyRule("birthday"),
  calls: defaultPrivacyRule("calls"),
  p2p: defaultPrivacyRule("p2p")
});
var SPOILER_FILL = "⠺⠵⠞⠟⠽⠾⠷⠯";
function hideSpoilers(text, entities) {
  if (!entities?.length)
    return text;
  let out = null;
  for (const e of entities) {
    if (e.type !== "spoiler")
      continue;
    out ??= text.split("");
    for (let i = e.offset;i < Math.min(text.length, e.offset + e.length); i++)
      if (!/\s/.test(text[i]))
        out[i] = SPOILER_FILL[i % SPOILER_FILL.length];
  }
  return out ? out.join("") : text;
}
function searchTerms(text) {
  const out = new Set;
  for (const w of text.normalize("NFC").toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || w.length > 32)
      continue;
    out.add(w);
    if (out.size >= 64)
      break;
  }
  return [...out];
}
var canEditKind = (kind) => !["sticker", "round", "voice", "poll", "todo", "contact", "geo", "dice"].includes(kind);

// packages/sync-engine/src/device.ts
var DB = "relay-device";
var STORE = "keys";
var ID = "device";
var b64 = (b) => {
  let s = "";
  for (const x of new Uint8Array(b))
    s += String.fromCharCode(x);
  return btoa(s);
};
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => {
      resolve(r.result);
      db.close();
    };
    r.onerror = () => {
      reject(r.error);
      db.close();
    };
  }));
}
var loading = null;
function deviceKey() {
  return loading ??= (async () => {
    const have = await tx("readonly", (s) => s.get(ID));
    if (have)
      return have;
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const made = { pair, spki: b64(await crypto.subtle.exportKey("spki", pair.publicKey)) };
    await tx("readwrite", (s) => s.add(made, ID)).catch(() => {});
    return await tx("readonly", (s) => s.get(ID)) ?? made;
  })().catch((e) => {
    loading = null;
    throw e;
  });
}
async function signDevice(purpose, nonce) {
  const { pair } = await deviceKey();
  return b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`relay-device|${purpose}|${nonce}`)));
}
var refreshing = null;
function refreshAccess(httpBase = "", f = fetch) {
  return refreshing ??= (async () => {
    const { spki } = await deviceKey();
    const c = await f(`${httpBase}/session/challenge`, { credentials: "include" });
    if (!c.ok)
      return false;
    const { nonce } = await c.json();
    const r = await f(`${httpBase}/session/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, sig: await signDevice("refresh", nonce), key: spki })
    });
    return r.ok;
  })().finally(() => {
    refreshing = null;
  });
}
var needsRefresh = (r) => r.status === 401 && r.headers.get("x-relay-auth") === "refresh";
function deviceFetch(inner, httpBase = "") {
  return async (url, init) => {
    const again = typeof Request !== "undefined" && url instanceof Request ? url.clone() : url;
    const res = await inner(url, init);
    if (!needsRefresh(res))
      return res;
    if (!await refreshAccess(httpBase, inner))
      return res;
    return inner(again, init);
  };
}
var BIND_REUSE_MS = 60000;
var bind = null;
function bindProof(httpBase = "", f = fetch) {
  if (bind && Date.now() - bind.at < BIND_REUSE_MS)
    return bind.p;
  const p = (async () => {
    const { spki } = await deviceKey();
    const c = await f(`${httpBase}/session/challenge`, { credentials: "include" });
    if (!c.ok)
      throw new Error(`challenge ${c.status}`);
    const { nonce } = await c.json();
    return { key: spki, nonce, sig: await signDevice("bind", nonce) };
  })();
  bind = { at: Date.now(), p };
  p.catch(() => {
    if (bind?.p === p)
      bind = null;
  });
  return p;
}
async function forgetDeviceKey() {
  loading = null;
  bind = null;
  await tx("readwrite", (s) => s.delete(ID)).catch(() => {});
}

// packages/sync-engine/src/host-core.ts
function fromMessagePort(port) {
  return {
    post: (m) => port.postMessage(m),
    listen: (cb) => {
      port.onmessage = (e) => cb(e.data);
    }
  };
}

class HostCore {
  opts;
  engine = null;
  clients = new Set;
  live = null;
  cfg = null;
  startedAt = Date.now();
  constructor(opts) {
    this.opts = opts;
  }
  get size() {
    return this.clients.size;
  }
  attach(port) {
    const c = { port, subs: new Map, queries: new Map, buf: [], queued: false, lastSeen: Date.now() };
    this.clients.add(c);
    port.listen((m) => {
      this.onMessage(c, m).catch((err) => {
        console.error("host:", err);
        this.live?.dev.log.error("host", err);
      });
    });
    return { detach: () => this.detach(c) };
  }
  sweep(maxIdleMs, now = Date.now()) {
    for (const c of [...this.clients])
      if (now - c.lastSeen > maxIdleMs)
        this.detach(c);
  }
  async close() {
    for (const c of [...this.clients])
      this.detach(c);
    if (this.engine)
      await (await this.engine).close();
    this.engine = null;
  }
  async onMessage(c, m) {
    c.lastSeen = Date.now();
    if (!this.clients.has(c) && m.t !== "bye")
      await this.revive(c);
    switch (m.t) {
      case "hello": {
        if (m.build !== this.opts.build) {
          c.port.post({ t: "reload" });
          return;
        }
        this.engine ??= this.start(m.config);
        await this.engine;
        c.port.post({ t: "ready" });
        return;
      }
      case "ping":
        c.port.post({ t: "pong" });
        return;
      case "bye":
        this.detach(c);
        return;
    }
    if (!this.engine)
      return;
    const engine = await this.engine;
    if (!this.clients.has(c))
      return;
    switch (m.t) {
      case "watch": {
        c.subs.get(m.sub)?.close();
        c.queries.set(m.sub, m.query);
        c.subs.set(m.sub, engine.watch(m.query, (patch) => this.queue(c, m.sub, patch)));
        return;
      }
      case "update":
        c.queries.set(m.sub, m.query);
        c.subs.get(m.sub)?.update(m.query);
        return;
      case "unwatch":
        c.subs.get(m.sub)?.close();
        c.subs.delete(m.sub);
        c.queries.delete(m.sub);
        return;
      case "call": {
        if (m.action.type === "dev" && m.action.cmd === "restartWorker") {
          await this.restart().then((value) => c.port.post({ t: "result", id: m.id, ok: true, value }), (err) => c.port.post({ t: "result", id: m.id, ok: false, error: String(err?.message ?? err) }));
          return;
        }
        try {
          const value = await engine.call(m.action);
          c.port.post({ t: "result", id: m.id, ok: true, value });
        } catch (err) {
          c.port.post({ t: "result", id: m.id, ok: false, error: String(err?.message ?? err) });
        }
        return;
      }
    }
  }
  start(cfg) {
    this.cfg = cfg;
    return this.opts.open(cfg).then((e) => {
      e.onObsolete(() => this.obsolete());
      e.onCall((frame) => {
        for (const c of this.clients)
          c.port.post({ t: "call", frame });
      });
      e.onTerminated(() => {
        if (this.live === e) {
          this.engine = null;
          this.live = null;
        }
      });
      e.dev.host = { build: this.opts.build, kind: this.opts.kind ?? "shared", clients: () => this.clients.size, startedAt: this.startedAt };
      this.live = e;
      e.connect();
      return e;
    });
  }
  async restart() {
    if (!this.engine || !this.cfg)
      throw new Error("not_started");
    const old = await this.engine, cfg = this.cfg;
    this.live = null;
    for (const c of this.clients) {
      for (const s of c.subs.values())
        s.close();
      c.subs.clear();
    }
    const next = old.close().then(() => this.start(cfg));
    this.engine = next;
    let e;
    try {
      e = await next;
    } catch (err) {
      if (this.engine === next) {
        this.engine = null;
        this.live = null;
      }
      for (const c of this.clients)
        c.port.post({ t: "reload" });
      throw err;
    }
    for (const c of this.clients)
      for (const [sub, q] of c.queries) {
        c.subs.get(sub)?.close();
        c.subs.set(sub, e.watch(q, (patch) => this.queue(c, sub, patch)));
      }
    return { restarted: "engine" };
  }
  obsolete() {
    this.engine = null;
    this.live = null;
    for (const c of this.clients)
      c.port.post({ t: "reload" });
  }
  queue(c, sub, patch) {
    c.buf.push({ sub, patch });
    if (c.queued)
      return;
    c.queued = true;
    queueMicrotask(() => {
      c.queued = false;
      const items = c.buf;
      c.buf = [];
      if (this.clients.has(c) && items.length)
        c.port.post({ t: "patches", items });
    });
  }
  async revive(c) {
    this.clients.add(c);
    if (!this.engine)
      return;
    const e = await this.engine;
    if (!this.clients.has(c))
      return;
    for (const [sub, q] of c.queries) {
      c.subs.get(sub)?.close();
      c.subs.set(sub, e.watch(q, (patch) => this.queue(c, sub, patch)));
    }
  }
  detach(c) {
    for (const s of c.subs.values())
      s.close();
    c.subs.clear();
    this.clients.delete(c);
  }
}

// packages/sync-engine/src/sessions.ts
var OP_SESSION = "session:";
var sessionKey = (id) => OP_SESSION + id;
var sessionConfirmKey = (id) => "sessionConfirm:" + id;
var OP_SESSIONS_OTHERS = "sessions:others";
var OP_SESSIONS_TTL = "sessionsTtl";
var isSessionOp = (key) => key.startsWith(OP_SESSION) || key === OP_SESSIONS_OTHERS;
function sessionsView(list, keys) {
  if (!keys.length)
    return [...list];
  const set = new Set(keys);
  const others = set.has(OP_SESSIONS_OTHERS);
  return list.filter((s) => s.current || !others && !set.has(sessionKey(s.id)));
}

class Sessions2 {
  h;
  constructor(h) {
    this.h = h;
  }
  async act(a) {
    switch (a.type) {
      case "listSessions": {
        if (!this.h.online())
          return { offline: true };
        try {
          const list = await this.h.http("/sessions");
          return { sessions: sessionsView(list, this.h.ops.list.map((o) => o.key)) };
        } catch {
          return { offline: true };
        }
      }
      case "terminateSession":
        await this.h.ops.enqueue({ key: sessionKey(a.id), method: "DELETE", path: `/sessions/${a.id}` });
        return null;
      case "confirmSession":
        await this.h.ops.enqueue({ key: sessionConfirmKey(a.id), method: "POST", path: `/sessions/${a.id}/confirm` });
        return null;
      case "terminateOtherSessions":
        await this.h.ops.enqueue({ key: OP_SESSIONS_OTHERS, method: "DELETE", path: "/sessions?others=1" });
        return null;
    }
  }
}

// packages/sync-engine/src/channel.ts
var isPost = (m) => !!m?.post;
var canPost = (c) => c.kind !== "channel" || !!c.me?.admin?.post;
var hasUnreadReplies = (m) => !!m?.replies && m.replies.lastId != null && m.replies.lastId > (m.replies.readMaxId ?? 0);
function shiftCounts(counts, prev, next) {
  const by = new Map(counts);
  if (prev) {
    const n = (by.get(prev) ?? 0) - 1;
    if (n > 0)
      by.set(prev, n);
    else
      by.delete(prev);
  }
  if (next)
    by.set(next, (by.get(next) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

class ViewCounter {
  deps;
  static MAX = 100;
  seen = new Map;
  queued = new Map;
  timer = null;
  lastAt = 0;
  inFlight = false;
  closed = false;
  constructor(deps) {
    this.deps = deps;
  }
  add(chatId, ids) {
    const seen = this.seen.get(chatId);
    let q = this.queued.get(chatId);
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || seen?.has(id))
        continue;
      if (!q) {
        q = new Set;
        this.queued.set(chatId, q);
      }
      q.add(id);
    }
    this.schedule();
  }
  get pending() {
    return this.queued.size > 0 || this.inFlight;
  }
  close() {
    this.closed = true;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = null;
  }
  schedule() {
    if (this.closed || this.timer || this.inFlight || !this.queued.size)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, Math.max(0, this.lastAt + this.deps.everyMs - Date.now()));
  }
  flush() {
    if (this.closed || !this.queued.size)
      return;
    if (!this.deps.online()) {
      this.lastAt = Date.now();
      this.schedule();
      return;
    }
    const [chatId, set] = this.queued.entries().next().value;
    const ids = [...set].slice(0, ViewCounter.MAX);
    for (const id of ids)
      set.delete(id);
    if (!set.size)
      this.queued.delete(chatId);
    this.inFlight = true;
    this.lastAt = Date.now();
    this.deps.run(async () => {
      const markSeen = () => {
        let seen = this.seen.get(chatId);
        if (!seen) {
          seen = new Set;
          this.seen.set(chatId, seen);
        }
        for (const id of ids)
          seen.add(id);
      };
      try {
        const res = await this.deps.post(chatId, ids);
        markSeen();
        this.deps.apply(chatId, res.views);
      } catch (err) {
        const msg = String(err?.message ?? "");
        if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg))
          markSeen();
        else
          this.add(chatId, ids);
      } finally {
        this.inFlight = false;
        this.lastAt = Date.now();
        this.schedule();
      }
    });
  }
}

// packages/sync-engine/src/text.ts
var cleanName = (s) => s.trim().replace(/\s+/g, " ");
var cleanText = (s) => s.replace(/\r\n?/g, `
`).trim();

export { LINK_SERVICES, LINK_SERVICE_IDS, MAX_LINKS, linkPrefix, linkUrl, linkLabel, parseLinkHandle, emojiKey, warmEmoji, emojiOnly, FOLDER_LIMITS, FOLDER_COLORS, graphemes, normalizeFolder, folderError, normalizeFolders, nextFolderId, MEMBER_RIGHTS, MEDIA_RIGHTS, ADMIN_RIGHTS_BY_KIND, SLOW_MODES, GROUP_ABOUT_MAX, RANK_MAX, INVITE_USAGE_MAX, allAdminRights, noAdminRights, hasMedia, rightsCount, rightForKind, isAdminRole, ADMIN_LOG_GROUPS, ADMIN_LOG_ACTIONS, ADMIN_LOG_LABELS, isDiceEmoji, blocksText, blocksToText, textToBlocks, FILE_CHUNK, encryptedSize, importFileKey, newFileKey, newNonceBase, sealedSource, openFile, toBase64, fromBase64, CALL_PING_MS, GROUP_CALL_PING_MS, GROUP_CALL_TITLE_MAX, SCHEDULED_LIMIT, SCHEDULE_MAX_MS, AUTO_DELETE_MIN_SEC, AUTO_DELETE_MAX_SEC, SAVED_GIFS_LIMIT, SAVED_TITLE, RECENT_STICKERS_LIMIT, FAVED_STICKERS_LIMIT, SAVED_NOTES, SAVED_HIDDEN, savedPeerRule, EMOJI_FX_MAX, EMOJI_FX_WINDOW_S, draftHash, locateQuote, makeQuote, MEDIA_TABS, isVideoMedia, mediaTabs, MAX_FILE_BYTES, NO_PREVIEW, PRIVACY_KEYS, defaultPrivacy, SPOILER_FILL, hideSpoilers, searchTerms, canEditKind, signDevice, refreshAccess, deviceFetch, bindProof, forgetDeviceKey, fromMessagePort, HostCore, sessionConfirmKey, OP_SESSIONS_TTL, isSessionOp, sessionsView, Sessions2, isPost, canPost, hasUnreadReplies, shiftCounts, ViewCounter, cleanName, cleanText };

//# debugId=E66F1299F21592FE64756E2164756E21
//# sourceMappingURL=main-p1twxvxz.js.map
