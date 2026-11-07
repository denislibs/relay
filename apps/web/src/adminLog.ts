import {
  ADMIN_LOG_ACTIONS, ADMIN_LOG_GROUPS, ADMIN_LOG_LABELS, ADMIN_LOG_RETENTION_HOURS,
  type AdminLogAction, type AdminLogEntry, type AdminLogGroup, type AdminLogMessage, type AdminLogPage, type AdminLogUser, type AdminRight, type AdminRights, type CommunityKind, type GroupReactions, type InviteFields, type MemberRight,
} from '@relay/protocol';
import { termText } from './autoDelete';
import { adminRightText, MEMBER_RIGHT_TEXT, SLOW_TEXT } from './rightsText';

// Журнал действий админов на клиенте: тексты записей, группировка по дням, логика фильтра и страниц. Без DOM (adminLog.test.ts).

export { ADMIN_LOG_RETENTION_HOURS };
export const GROUP_LABELS: Record<AdminLogGroup, string> = { members: 'Участники', admins: 'Администраторы', settings: 'Настройки', messages: 'Сообщения', invites: 'Ссылки' };
export const GROUP_ORDER: AdminLogGroup[] = ['members', 'admins', 'settings', 'messages', 'invites'];

/** Кусок текста записи. b — значение жирным; user — имя (кликабельное, если человек есть); msg — ссылка на сообщение (есть, только если сообщение доступно). */
export type Seg = { t: 'text'; v: string } | { t: 'b'; v: string } | { t: 'user'; id: number | null; name: string } | { t: 'msg'; v: string; message: AdminLogMessage };

export interface TextCtx { kind: CommunityKind; users: Map<number, AdminLogUser>; chats: Map<number, string> }

/** Пользователь удалён или неизвестен: нейтрально, как в остальном проекте. */
export const UNKNOWN_NAME = 'Пользователь';

const text = (v: string): Seg => ({ t: 'text', v });
const bold = (v: string): Seg => ({ t: 'b', v });
const nameOf = (id: number | null | undefined, c: TextCtx): Seg => ({ t: 'user', id: id != null && c.users.get(id)?.name != null ? id : null, name: (id != null ? c.users.get(id)?.name : null) ?? UNKNOWN_NAME });

const KIND_TEXT: Record<string, string> = { photo: 'Фото', video: 'Видео', file: 'Файл', voice: 'Голосовое сообщение', round: 'Видеосообщение', audio: 'Музыка', todo: 'Чек-лист', sticker: 'Стикер', poll: 'Опрос', contact: 'Контакт', geo: 'Геопозиция', dice: 'Кубик' };
/** Подпись сообщения в записи: текст, а если его нет — вид. */
export function messageLabel(m: AdminLogMessage): string {
  const body = m.body.replace(/\s+/g, ' ').trim();
  return body || KIND_TEXT[m.kind] || 'Сообщение';
}

const ON_OFF = (on: boolean, yes: string, no: string) => (on ? yes : no);
const slow = (s: number) => SLOW_TEXT[s] ?? `${s} с`;
const term = (s: number | null) => (s ? termText(s) : 'выкл.');

function reactionsText(r: GroupReactions): string {
  if (r.mode === 'all') return 'все';
  if (r.mode === 'none') return 'никаких';
  return r.allowed.length ? r.allowed.join(' ') : 'некоторые';
}

/** Что стало разрешено и что запрещено при переходе from → to. */
function diffRights<K extends string>(from: Record<K, boolean> | null, to: Record<K, boolean> | null, label: (k: K) => string, keys: readonly K[], plus: string, minus: string): Seg[] {
  const added = keys.filter((k) => !!to?.[k] && !from?.[k]).map(label), removed = keys.filter((k) => !!from?.[k] && !to?.[k]).map(label);
  const parts: Seg[] = [];
  if (added.length) parts.push(text(`${plus}: `), bold(added.join(', ')));
  if (removed.length) parts.push(text(added.length ? `; ${minus}: ` : `${minus}: `), bold(removed.join(', ')));
  return parts;
}
const MEMBER_KEYS = Object.keys(MEMBER_RIGHT_TEXT) as MemberRight[];
const ADMIN_KEYS = ['info', 'post', 'edit', 'delete', 'ban', 'invite', 'pin', 'calls', 'addAdmins'] as AdminRight[];

function inviteDiff(from: InviteFields, to: InviteFields): Seg[] {
  const parts: Seg[][] = [];
  if (from.title !== to.title) parts.push([text('название: '), bold(to.title ?? 'без названия')]);
  if (from.expiresAt !== to.expiresAt) parts.push([text(to.expiresAt ? 'срок изменён' : 'срок снят')]);
  if (from.usageLimit !== to.usageLimit) parts.push([text('лимит: '), bold(to.usageLimit == null ? 'без лимита' : String(to.usageLimit))]);
  if (from.approval !== to.approval) parts.push([text(to.approval ? 'с одобрением заявок' : 'без одобрения заявок')]);
  return parts.flatMap((p, i) => (i ? [text('; '), ...p] : p));
}
const linkLabel = (d: { mask: string; title?: string | null }) => (d.title ? `«${d.title}» (${d.mask})` : d.mask);
const fromTo = (a: string, b: string): Seg[] => [bold(a), text(' → '), bold(b)];

/** Текст записи (без имени исполнителя в начале — оно первым сегментом). Склонение — «(а)», как в остальном проекте. */
export function adminLogText(e: AdminLogEntry, c: TextCtx): Seg[] {
  const who = nameOf(e.actorId, c);
  const line = (...rest: Seg[]): Seg[] => [who, text(' '), ...rest];
  const channel = c.kind === 'channel';
  const target = (id: number | undefined) => nameOf(id, c);
  /** «сообщение от X»: живое — ссылкой на него ниже (msg), текст подставляет messageSeg. */
  const about = (d: { target?: number; hidden?: boolean }, noun: string): Seg[] => (d.target != null && !d.hidden ? [text(`${noun} от `), target(d.target)] : [text(noun)]);
  switch (e.action) {
    case 'title_changed': return line(text('изменил(а) название: '), ...fromTo(e.data.from, e.data.to));
    case 'about_changed':
      if (!e.data.to) return line(text('удалил(а) описание'));
      return e.data.from ? line(text('изменил(а) описание: '), ...fromTo(e.data.from, e.data.to)) : line(text('добавил(а) описание: '), bold(e.data.to));
    case 'photo_changed': return line(text('изменил(а) фото'));
    case 'photo_removed': return line(text('удалил(а) фото'));
    case 'username_changed':
      if (!e.data.to) return line(text('убрал(а) публичный адрес '), bold('@' + e.data.from));
      return e.data.from ? line(text('изменил(а) адрес: '), ...fromTo('@' + e.data.from, '@' + e.data.to)) : line(text('задал(а) публичный адрес '), bold('@' + e.data.to));
    case 'signatures_toggled': return line(text(ON_OFF(e.data.on, 'включил(а) подписи постов', 'выключил(а) подписи постов')));
    case 'protected_toggled': return line(text(ON_OFF(e.data.on, 'запретил(а) копирование содержимого', 'разрешил(а) копирование содержимого')));
    case 'theme_changed': {
      const t = e.data.to;
      return t ? line(text('изменил(а) тему чата на '), bold(`${t.emoji} ${t.title}`)) : line(text('отключил(а) тему чата'));
    }
    case 'auto_delete_changed':
      if (!e.data.to) return line(text('выключил(а) автоудаление'));
      return e.data.from ? line(text('изменил(а) автоудаление: '), ...fromTo(term(e.data.from), term(e.data.to))) : line(text('включил(а) автоудаление: '), bold(term(e.data.to)));
    case 'slow_mode_changed':
      if (!e.data.to) return line(text('выключил(а) медленный режим'));
      return e.data.from ? line(text('изменил(а) медленный режим: '), ...fromTo(slow(e.data.from), slow(e.data.to))) : line(text('включил(а) медленный режим: '), bold(slow(e.data.to)));
    case 'history_toggled': return line(text(ON_OFF(e.data.hidden, 'скрыл(а) историю чата для новых участников', 'открыл(а) историю чата для новых участников')));
    case 'join_approval_toggled': return line(text(ON_OFF(e.data.on, 'включил(а) вступление по заявке', 'выключил(а) вступление по заявке')));
    case 'join_to_send_toggled': return line(text(ON_OFF(e.data.on, 'разрешил(а) комментировать только участникам', 'разрешил(а) комментировать без вступления')));
    case 'linked_chat_changed': {
      const noun = channel ? 'группу обсуждения' : 'канал';
      const title = (id: number | null) => (id != null ? c.chats.get(id) : undefined);
      const to = title(e.data.to), from = title(e.data.from);
      if (e.data.to == null) return line(text(`отвязал(а) ${noun}`), ...(from ? [text(' '), bold(from)] : []));
      return line(text(e.data.from == null ? `привязал(а) ${noun}` : `сменил(а) ${noun}`), ...(to ? [text(' '), bold(to)] : []));
    }
    case 'reactions_changed': return line(text('изменил(а) реакции: '), ...fromTo(reactionsText(e.data.from), reactionsText(e.data.to)));
    case 'default_rights_changed': return line(text('изменил(а) права участников'), ...withDash(diffRights(e.data.from, e.data.to, (k: MemberRight) => MEMBER_RIGHT_TEXT[k], MEMBER_KEYS, 'разрешено', 'запрещено')));
    case 'member_added': return line(text('добавил(а) '), target(e.data.target));
    case 'member_joined':
      return e.data.via === 'link' && e.data.mask ? line(text('вступил(а) по ссылке '), bold(e.data.mask)) : e.data.via === 'discussion' ? line(text('вступил(а) из обсуждения')) : line(text('вступил(а)'));
    case 'member_left': return line(text('вышел(а)'));
    case 'member_banned': return line(text('исключил(а) '), target(e.data.target));
    case 'member_unbanned': return line(text('снял(а) исключение с '), target(e.data.target));
    case 'member_restricted': return line(text('ограничил(а) '), target(e.data.target), ...withDash(diffRights(e.data.from, e.data.to, (k: MemberRight) => MEMBER_RIGHT_TEXT[k], MEMBER_KEYS, 'разрешено', 'запрещено')));
    case 'member_unrestricted': return line(text('снял(а) ограничения с '), target(e.data.target));
    case 'request_approved': return line(text('одобрил(а) заявку '), target(e.data.target));
    case 'request_declined': return line(text('отклонил(а) заявку '), target(e.data.target));
    case 'admin_promoted': {
      const on = ADMIN_KEYS.filter((k) => e.data.rights[k]).map((k) => adminRightText(k, c.kind));
      return line(text('назначил(а) администратором '), target(e.data.target), ...(e.data.rank ? [text(' со званием '), bold(e.data.rank)] : []), ...(on.length ? [text(': '), bold(on.join(', '))] : []));
    }
    case 'admin_edited': return line(text('изменил(а) права администратора '), target(e.data.target), ...withDash(diffRights(e.data.from as AdminRights, e.data.to as AdminRights, (k: AdminRight) => adminRightText(k, c.kind), ADMIN_KEYS, 'добавлено', 'убрано')));
    case 'admin_demoted': return line(text('снял(а) с поста администратора '), target(e.data.target));
    case 'admin_rank_changed':
      return e.data.to ? line(text('изменил(а) звание '), target(e.data.target), text(': '), bold(e.data.to)) : line(text('убрал(а) звание '), target(e.data.target));
    case 'owner_transferred':
      return e.data.auto ? line(text('вышел(а), права владельца перешли к '), target(e.data.target)) : line(text('передал(а) права владельца '), target(e.data.target));
    case 'message_deleted': return line(text('удалил(а) '), ...about(e.data, channel ? 'публикацию' : 'сообщение'));
    case 'message_edited': return line(text('изменил(а) '), ...about(e.data, channel ? 'публикацию' : 'сообщение'));
    case 'message_pinned': return line(text('закрепил(а) '), ...about(e.data, channel ? 'публикацию' : 'сообщение'));
    case 'message_unpinned': return line(text('открепил(а) '), ...about(e.data, channel ? 'публикацию' : 'сообщение'));
    case 'all_unpinned': return line(text(`открепил(а) все сообщения (${e.data.count})`));
    case 'poll_closed': return line(text('закрыл(а) '), ...about(e.data, 'опрос'));
    case 'invite_created': return line(text(e.data.primary ? 'создал(а) новую основную ссылку ' : 'создал(а) ссылку '), bold(linkLabel(e.data)));
    case 'invite_edited': return line(text('изменил(а) ссылку '), bold(e.data.mask), ...withColon(inviteDiff(e.data.from, e.data.to)));
    case 'invite_revoked': return line(text(e.data.primary ? 'отозвал(а) основную ссылку ' : 'отозвал(а) ссылку '), bold(linkLabel(e.data)));
    case 'invite_deleted': return line(text('удалил(а) ссылку '), bold(linkLabel(e.data)));
  }
}
const withColon = (rest: Seg[]): Seg[] => (rest.length ? [text(': '), ...rest] : []);
/** Перед списком с собственными подписями («запрещено: …»): второе двоеточие подряд читается плохо. */
const withDash = (rest: Seg[]): Seg[] => (rest.length ? [text(' — '), ...rest] : []);

/** Текст записи одной строкой: для aria-метки и решения, нужен ли «Подробнее». */
export const segsText = (segs: Seg[]): string => segs.map((s) => (s.t === 'user' ? s.name : s.v)).join('');

/** В строку помещается примерно столько (зажато по высоте); длиннее — показываем кнопку «Подробнее» с полным текстом. */
export const ROW_TEXT_FIT = 90;
export const needsDetails = (segs: Seg[]): boolean => segsText(segs).length > ROW_TEXT_FIT;

/** Ссылка на сообщение: только когда сервер его отдал (доступно обычным чтением). */
export function messageSeg(e: AdminLogEntry): Seg | null {
  return e.message ? { t: 'msg', v: messageLabel(e.message), message: e.message } : null;
}

/** Подпись под записью об удалённом: сообщения больше нет, только дата. */
export const deletedAt = (e: AdminLogEntry): string | null => (e.action === 'message_deleted' && e.data.at ? e.data.at : null);

// ---- дни ----

const dayOf = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
export interface LogDay { key: string; label: string; entries: AdminLogEntry[] }
/** Записи (новые сверху) по дням; порядок записей сохраняется. День — местный, как у остальных дат в клиенте. */
export function groupByDay(entries: AdminLogEntry[], labelOf: (iso: string) => string): LogDay[] {
  const out: LogDay[] = [];
  for (const e of entries) {
    const key = dayOf(e.at), last = out[out.length - 1];
    if (last?.key === key) last.entries.push(e);
    else out.push({ key, label: labelOf(e.at), entries: [e] });
  }
  return out;
}

// ---- страницы ----

export interface LogState { entries: AdminLogEntry[]; users: Map<number, AdminLogUser>; chats: Map<number, string>; hasMore: boolean }
export const EMPTY_LOG: LogState = { entries: [], users: new Map(), chats: new Map(), hasMore: false };

/** Новая страница поверх прежнего: хвост дописывается по before, повторы по id отбрасываются (порядок — новые сверху). */
export function appendPage(prev: LogState, page: AdminLogPage): LogState {
  const seen = new Set(prev.entries.map((e) => e.id));
  const users = new Map(prev.users), chats = new Map(prev.chats);
  for (const u of page.users) users.set(u.id, u);
  for (const c of page.chats) chats.set(c.id, c.title);
  return { entries: [...prev.entries, ...page.entries.filter((e) => !seen.has(e.id))], users, chats, hasMore: page.hasMore };
}

// ---- фильтр ----

export interface LogFilter { actions: AdminLogAction[]; actors: number[]; q: string }
export const NO_FILTER: LogFilter = { actions: [], actors: [], q: '' };
export const filterActive = (f: LogFilter): boolean => f.actions.length > 0 || f.actors.length > 0 || !!f.q.trim();

export function groupState(f: LogFilter, g: AdminLogGroup): 'all' | 'some' | 'none' {
  const list = ADMIN_LOG_GROUPS[g] as readonly AdminLogAction[];
  const n = list.filter((a) => f.actions.includes(a)).length;
  return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
}
/** Галочка группы: выбрана целиком — снять всю, иначе выбрать всю. */
export function toggleGroup(f: LogFilter, g: AdminLogGroup): LogFilter {
  const list = ADMIN_LOG_GROUPS[g] as readonly AdminLogAction[];
  const rest = f.actions.filter((a) => !list.includes(a));
  return { ...f, actions: groupState(f, g) === 'all' ? rest : [...rest, ...list] };
}
export function toggleAction(f: LogFilter, a: AdminLogAction): LogFilter {
  return { ...f, actions: f.actions.includes(a) ? f.actions.filter((x) => x !== a) : [...f.actions, a] };
}
export function toggleActor(f: LogFilter, id: number): LogFilter {
  return { ...f, actors: f.actors.includes(id) ? f.actors.filter((x) => x !== id) : [...f.actors, id] };
}

export type Chip = { key: string; label: string; remove: (f: LogFilter) => LogFilter };
/** Чипы активного фильтра: группа целиком — одним чипом, отдельные типы — каждый своим, исполнители — по имени. */
export function filterChips(f: LogFilter, actorName: (id: number) => string): Chip[] {
  const chips: Chip[] = [];
  if (f.q.trim()) chips.push({ key: 'q', label: `«${f.q.trim()}»`, remove: (x) => ({ ...x, q: '' }) });
  for (const g of GROUP_ORDER) {
    const st = groupState(f, g);
    if (st === 'all') chips.push({ key: 'g:' + g, label: GROUP_LABELS[g], remove: (x) => toggleGroup(x, g) });
    else if (st === 'some') for (const a of ADMIN_LOG_GROUPS[g] as readonly AdminLogAction[]) if (f.actions.includes(a)) chips.push({ key: 'a:' + a, label: ADMIN_LOG_LABELS[a], remove: (x) => toggleAction(x, a) });
  }
  for (const id of f.actors) chips.push({ key: 'u:' + id, label: actorName(id), remove: (x) => toggleActor(x, id) });
  return chips;
}

/** Адрес страницы журнала. Порядок типов — как в протоколе: один и тот же фильтр даёт один и тот же запрос. */
export function logPath(chatId: number, f: LogFilter, before: number | null, limit = 50): string {
  const p = new URLSearchParams();
  if (before != null) p.set('before', String(before));
  p.set('limit', String(limit));
  if (f.actions.length) p.set('actions', ADMIN_LOG_ACTIONS.filter((a) => f.actions.includes(a)).join(','));
  if (f.actors.length) p.set('actors', [...f.actors].sort((a, b) => a - b).join(','));
  if (f.q.trim()) p.set('q', f.q.trim());
  return `/chats/${chatId}/admin-log?${p}`;
}

/** Что показать вместо ленты. */
export type LogView = 'list' | 'loading' | 'offline' | 'denied' | 'error' | 'empty' | 'emptyFiltered';
export function logView(s: { entries: number; status: 'loading' | 'ready' | 'offline' | 'denied' | 'error' }, f: LogFilter): LogView {
  if (s.status === 'denied') return 'denied';
  if (s.entries) return 'list';   // уже показанное остаётся и при обрыве: хвост скажет сам
  if (s.status === 'ready') return filterActive(f) ? 'emptyFiltered' : 'empty';
  return s.status;
}
/** Код ошибки groupCall → состояние: нет сети, нет доступа (сняли с поста, вышел, чат удалён) или сбой. */
export const logFailure = (code: string): 'offline' | 'denied' | 'error' => (code === 'offline' ? 'offline' : code === 'forbidden' || code === 'not_member' || code === 'not_found' ? 'denied' : 'error');
