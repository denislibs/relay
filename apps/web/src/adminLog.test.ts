import { expect, test } from 'bun:test';
import { ADMIN_LOG_ACTIONS, ADMIN_LOG_GROUPS, ADMIN_LOG_LABELS, type AdminLogAction, type AdminLogEntry, type AdminLogPage, type AdminLogUser } from '@relay/protocol';
import {
  adminLogText, appendPage, EMPTY_LOG, filterActive, filterChips, groupByDay, groupState, logFailure, logPath, logView, messageLabel, messageSeg, needsDetails, NO_FILTER, segsText, toggleAction, toggleActor, toggleGroup, UNKNOWN_NAME, type LogFilter, type TextCtx,
} from './adminLog';

const users = new Map<number, AdminLogUser>([
  [1, { id: 1, name: 'Анна', photo: null, key: 'k1' }], [2, { id: 2, name: 'Борис', photo: null }], [3, { id: 3, name: null, photo: null }],
]);
const ctx = (kind: 'group' | 'channel' = 'group', chats: [number, string][] = []): TextCtx => ({ kind, users, chats: new Map(chats) });
const entry = <A extends AdminLogAction>(action: A, data: unknown, actorId: number | null = 1, extra: Partial<AdminLogEntry> = {}): AdminLogEntry => ({ id: 1, at: '2026-11-04T10:00:00.000Z', action, actorId, data, ...extra }) as AdminLogEntry;
const say = (e: AdminLogEntry, c = ctx()) => segsText(adminLogText(e, c));
const ON = { text: true, photos: true, videos: true, files: true, music: true, voice: true, round: true, stickers: true, links: true, react: true, invite: true, pin: true, info: true };

test('settings texts: from → to in bold, with (а)', () => {
  const segs = adminLogText(entry('title_changed', { from: 'Было', to: 'Стало' }), ctx());
  expect(segs[0]).toEqual({ t: 'user', id: 1, name: 'Анна' });
  expect(segs.filter((s) => s.t === 'b').map((s) => (s as { v: string }).v)).toEqual(['Было', 'Стало']);
  expect(segsText(segs)).toBe('Анна изменил(а) название: Было → Стало');
  expect(say(entry('about_changed', { from: '', to: 'Описание' }))).toBe('Анна добавил(а) описание: Описание');
  expect(say(entry('about_changed', { from: 'Описание', to: '' }))).toBe('Анна удалил(а) описание');
  expect(say(entry('about_changed', { from: 'А', to: 'Б' }))).toBe('Анна изменил(а) описание: А → Б');
  expect(say(entry('photo_changed', {}))).toBe('Анна изменил(а) фото');
  expect(say(entry('photo_removed', {}))).toBe('Анна удалил(а) фото');
  expect(say(entry('username_changed', { from: null, to: 'abc' }))).toBe('Анна задал(а) публичный адрес @abc');
  expect(say(entry('username_changed', { from: 'abc', to: 'def' }))).toBe('Анна изменил(а) адрес: @abc → @def');
  expect(say(entry('username_changed', { from: 'abc', to: null }))).toBe('Анна убрал(а) публичный адрес @abc');
  expect(say(entry('signatures_toggled', { on: true }))).toBe('Анна включил(а) подписи постов');
  expect(say(entry('signatures_toggled', { on: false }))).toBe('Анна выключил(а) подписи постов');
  expect(say(entry('protected_toggled', { on: true }))).toBe('Анна запретил(а) копирование содержимого');
  expect(say(entry('theme_changed', { from: null, to: { emoji: '🐥', title: 'Цыплёнок' } }))).toBe('Анна изменил(а) тему чата на 🐥 Цыплёнок');
  expect(say(entry('theme_changed', { from: { emoji: '🐥', title: 'Цыплёнок' }, to: null }))).toBe('Анна отключил(а) тему чата');
  expect(say(entry('auto_delete_changed', { from: null, to: 86400 }))).toBe('Анна включил(а) автоудаление: 1 день');
  expect(say(entry('auto_delete_changed', { from: 86400, to: 604800 }))).toBe('Анна изменил(а) автоудаление: 1 день → 1 неделя');
  expect(say(entry('auto_delete_changed', { from: 86400, to: null }))).toBe('Анна выключил(а) автоудаление');
  expect(say(entry('slow_mode_changed', { from: 0, to: 30 }))).toBe('Анна включил(а) медленный режим: 30 с');
  expect(say(entry('slow_mode_changed', { from: 30, to: 60 }))).toBe('Анна изменил(а) медленный режим: 30 с → 1 мин');
  expect(say(entry('slow_mode_changed', { from: 30, to: 0 }))).toBe('Анна выключил(а) медленный режим');
  expect(say(entry('history_toggled', { hidden: true }))).toBe('Анна скрыл(а) историю чата для новых участников');
  expect(say(entry('join_approval_toggled', { on: true }))).toBe('Анна включил(а) вступление по заявке');
  expect(say(entry('join_to_send_toggled', { on: true }))).toBe('Анна разрешил(а) комментировать только участникам');
  expect(say(entry('reactions_changed', { from: { mode: 'all', allowed: [] }, to: { mode: 'some', allowed: ['👍', '❤'] } }))).toBe('Анна изменил(а) реакции: все → 👍 ❤');
  expect(say(entry('default_rights_changed', { from: ON, to: { ...ON, photos: false, pin: false } }))).toBe('Анна изменил(а) права участников: запрещено: Фото, Закрепление сообщений');
  expect(say(entry('default_rights_changed', { from: { ...ON, photos: false }, to: { ...ON, pin: false } }))).toBe('Анна изменил(а) права участников: разрешено: Фото; запрещено: Закрепление сообщений');
});

test('the linked chat is named only when the server gave its title', () => {
  expect(say(entry('linked_chat_changed', { from: null, to: 7 }), ctx('channel', [[7, 'Обсуждения']]))).toBe('Анна привязал(а) группу обсуждения Обсуждения');
  expect(say(entry('linked_chat_changed', { from: null, to: 7 }), ctx('channel'))).toBe('Анна привязал(а) группу обсуждения');
  expect(say(entry('linked_chat_changed', { from: 7, to: null }), ctx('group'))).toBe('Анна отвязал(а) канал');
  expect(say(entry('linked_chat_changed', { from: 7, to: 8 }), ctx('channel', [[8, 'Новая']]))).toBe('Анна сменил(а) группу обсуждения Новая');
});

test('members, admins, requests', () => {
  expect(say(entry('member_added', { target: 2 }))).toBe('Анна добавил(а) Борис');
  expect(say(entry('member_joined', { target: 1, via: 'link', mask: 'abcd…' }))).toBe('Анна вступил(а) по ссылке abcd…');
  expect(say(entry('member_joined', { target: 1, via: 'username' }))).toBe('Анна вступил(а)');
  expect(say(entry('member_joined', { target: 1, via: 'discussion' }))).toBe('Анна вступил(а) из обсуждения');
  expect(say(entry('member_left', { target: 1 }))).toBe('Анна вышел(а)');
  expect(say(entry('member_banned', { target: 2 }))).toBe('Анна исключил(а) Борис');
  expect(say(entry('member_unbanned', { target: 2 }))).toBe('Анна снял(а) исключение с Борис');
  expect(say(entry('member_restricted', { target: 2, from: ON, to: { ...ON, text: false } }))).toBe('Анна ограничил(а) Борис: запрещено: Отправка сообщений');
  expect(say(entry('member_unrestricted', { target: 2 }))).toBe('Анна снял(а) ограничения с Борис');
  expect(say(entry('request_approved', { target: 2 }))).toBe('Анна одобрил(а) заявку Борис');
  expect(say(entry('request_declined', { target: 2 }))).toBe('Анна отклонил(а) заявку Борис');
  const rights = { info: false, post: false, edit: false, delete: true, ban: false, invite: false, pin: false, addAdmins: false };
  expect(say(entry('admin_promoted', { target: 2, rights, rank: 'Мод' }))).toBe('Анна назначил(а) администратором Борис со званием Мод: Удаление сообщений');
  expect(say(entry('admin_promoted', { target: 2, rights, rank: null }), ctx('channel'))).toBe('Анна назначил(а) администратором Борис: Удаление чужих публикаций');
  expect(say(entry('admin_edited', { target: 2, from: rights, to: { ...rights, delete: false, pin: true } }))).toBe('Анна изменил(а) права администратора Борис: добавлено: Закрепление сообщений; убрано: Удаление сообщений');
  expect(say(entry('admin_demoted', { target: 2 }))).toBe('Анна снял(а) с поста администратора Борис');
  expect(say(entry('admin_rank_changed', { target: 2, from: null, to: 'Глава' }))).toBe('Анна изменил(а) звание Борис: Глава');
  expect(say(entry('admin_rank_changed', { target: 2, from: 'Глава', to: null }))).toBe('Анна убрал(а) звание Борис');
  expect(say(entry('owner_transferred', { target: 2 }))).toBe('Анна передал(а) права владельца Борис');
  expect(say(entry('owner_transferred', { target: 2, auto: true }))).toBe('Анна вышел(а), права владельца перешли к Борис');
});

test('messages and invites; no text in a deleted message', () => {
  expect(say(entry('message_deleted', { messageId: 5, target: 2, at: 'x' }))).toBe('Анна удалил(а) сообщение от Борис');
  expect(say(entry('message_deleted', { messageId: 5, target: 2, at: 'x' }), ctx('channel'))).toBe('Анна удалил(а) публикацию от Борис');
  expect(say(entry('message_pinned', { hidden: true }))).toBe('Анна закрепил(а) сообщение');   // скрытая история: без автора
  expect(say(entry('message_unpinned', { messageId: 5, target: 2 }))).toBe('Анна открепил(а) сообщение от Борис');
  expect(say(entry('message_edited', { messageId: 5, target: 2 }), ctx('channel'))).toBe('Анна изменил(а) публикацию от Борис');
  expect(say(entry('all_unpinned', { count: 3 }))).toBe('Анна открепил(а) все сообщения (3)');
  expect(say(entry('poll_closed', { messageId: 5, target: 2 }))).toBe('Анна закрыл(а) опрос от Борис');
  expect(say(entry('invite_created', { inviteId: 1, mask: 'abcd…', title: 'Соседи', expiresAt: null, usageLimit: null, approval: false }))).toBe('Анна создал(а) ссылку «Соседи» (abcd…)');
  expect(say(entry('invite_created', { inviteId: 1, mask: 'abcd…', title: null, expiresAt: null, usageLimit: null, approval: false, primary: true }))).toBe('Анна создал(а) новую основную ссылку abcd…');
  const f = { title: null, expiresAt: null, usageLimit: null, approval: false };
  expect(say(entry('invite_edited', { inviteId: 1, mask: 'abcd…', from: f, to: { ...f, title: 'Новая', usageLimit: 5, approval: true } }))).toBe('Анна изменил(а) ссылку abcd…: название: Новая; лимит: 5; с одобрением заявок');
  expect(say(entry('invite_revoked', { inviteId: 1, mask: 'abcd…', title: null }))).toBe('Анна отозвал(а) ссылку abcd…');
  expect(say(entry('invite_deleted', { inviteId: 1, mask: 'abcd…', title: 'Соседи' }))).toBe('Анна удалил(а) ссылку «Соседи» (abcd…)');
  // ссылка на сообщение — только когда сервер отдал сообщение
  const live = { id: 5, kind: 'text', body: 'Привет,\nмир' };
  expect(messageSeg(entry('message_pinned', { messageId: 5 }, 1, { message: live }))).toEqual({ t: 'msg', v: 'Привет, мир', message: live });
  expect(messageSeg(entry('message_pinned', { messageId: 5 }, 1, { message: null }))).toBeNull();
  expect(messageLabel({ id: 5, kind: 'photo', body: '' })).toBe('Фото');
  expect(messageLabel({ id: 5, kind: 'weird', body: '' })).toBe('Сообщение');
});

test('every action has a text and a label; none falls through', () => {
  const sample: Record<string, unknown> = {
    title_changed: { from: '', to: '' }, about_changed: { from: '', to: 'x' }, username_changed: { from: null, to: 'x' }, reactions_changed: { from: { mode: 'all', allowed: [] }, to: { mode: 'none', allowed: [] } },
    default_rights_changed: { from: ON, to: ON }, member_restricted: { target: 2, from: ON, to: ON }, admin_promoted: { target: 2, rights: {}, rank: null }, admin_edited: { target: 2, from: {}, to: {} },
    invite_edited: { mask: 'a', from: { title: null }, to: { title: null } }, linked_chat_changed: { from: null, to: 1 }, theme_changed: { from: null, to: null },
  };
  for (const a of ADMIN_LOG_ACTIONS) {
    expect(ADMIN_LOG_LABELS[a]).toBeTruthy();
    expect(say(entry(a, sample[a] ?? { target: 2, mask: 'a', count: 1 }))).toStartWith('Анна ');
  }
});

test('a deleted actor or target is neutral and not clickable', () => {
  const gone = adminLogText(entry('member_banned', { target: 3 }, 3), ctx());
  expect(gone[0]).toEqual({ t: 'user', id: null, name: UNKNOWN_NAME });
  expect(gone.at(-1)).toEqual({ t: 'user', id: null, name: UNKNOWN_NAME });
  expect(adminLogText(entry('member_left', { target: 9 }, null), ctx())[0]).toEqual({ t: 'user', id: null, name: UNKNOWN_NAME });
});

test('long entries offer details; short ones do not', () => {
  expect(needsDetails(adminLogText(entry('member_left', { target: 1 }), ctx()))).toBe(false);
  expect(needsDetails(adminLogText(entry('about_changed', { from: 'я'.repeat(100), to: 'ю' }), ctx()))).toBe(true);
});

test('grouping by local day keeps the order', () => {
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
  const es = [entry('member_left', {}, 1, { id: 5, at: at(4, 23) }), entry('member_left', {}, 1, { id: 4, at: at(4, 0) }), entry('member_left', {}, 1, { id: 3, at: at(3, 23) }), entry('member_left', {}, 1, { id: 2, at: at(2, 12) })];
  const days = groupByDay(es, (iso) => 'день ' + new Date(iso).getDate());
  expect(days.map((d) => [d.label, d.entries.map((e) => e.id)])).toEqual([['день 4', [5, 4]], ['день 3', [3]], ['день 2', [2]]]);
  expect(groupByDay([], () => '')).toEqual([]);
});

test('pages: the tail appends, repeats drop, users and chats accumulate', () => {
  const p = (ids: number[], hasMore: boolean, u: AdminLogUser[] = []): AdminLogPage => ({ entries: ids.map((id) => entry('member_left', {}, 1, { id })), users: u, chats: [{ id: ids[0], title: 'т' }], hasMore });
  let s = appendPage(EMPTY_LOG, p([9, 8], true, [{ id: 1, name: 'А', photo: null }]));
  s = appendPage(s, p([8, 7], false, [{ id: 2, name: 'Б', photo: null }]));
  expect(s.entries.map((e) => e.id)).toEqual([9, 8, 7]);
  expect([...s.users.keys()]).toEqual([1, 2]);
  expect(s.hasMore).toBe(false);
  expect(s.chats.size).toBe(2);
  expect(EMPTY_LOG.entries).toEqual([]);   // исходное не меняется
});

test('filter: groups toggle, partial state, actors, chips, reset', () => {
  let f: LogFilter = NO_FILTER;
  expect(filterActive(f)).toBe(false);
  f = toggleGroup(f, 'members');
  expect(groupState(f, 'members')).toBe('all');
  expect(f.actions).toEqual([...ADMIN_LOG_GROUPS.members]);
  f = toggleAction(f, 'member_left');
  expect(groupState(f, 'members')).toBe('some');
  f = toggleGroup(f, 'members');   // частично выбранная — выбрать всю
  expect(groupState(f, 'members')).toBe('all');
  f = toggleGroup(f, 'members');
  expect(f.actions).toEqual([]);
  f = toggleActor(toggleAction(toggleGroup(NO_FILTER, 'invites'), 'title_changed'), 2);
  f = { ...f, q: '  борис ' };
  const chips = filterChips(f, (id) => (id === 2 ? 'Борис' : '?'));
  expect(chips.map((c) => c.label)).toEqual(['«борис»', ADMIN_LOG_LABELS.title_changed, 'Ссылки', 'Борис']);
  // снятие чипа убирает только своё
  const noLinks = chips.find((c) => c.label === 'Ссылки')!.remove(f);
  expect(groupState(noLinks, 'invites')).toBe('none');
  expect(noLinks.actions).toEqual(['title_changed']);
  expect(chips.find((c) => c.label === 'Борис')!.remove(f).actors).toEqual([]);
  expect(chips.find((c) => c.key === 'q')!.remove(f).q).toBe('');
  expect(filterActive({ ...NO_FILTER, q: '   ' })).toBe(false);
});

test('the request: same filter — same address; query is encoded; order is stable', () => {
  const a: LogFilter = { actions: ['title_changed', 'member_left'], actors: [5, 2], q: ' а&б ' };
  const b: LogFilter = { actions: ['member_left', 'title_changed'], actors: [2, 5], q: 'а&б' };
  expect(logPath(1, a, 10, 20)).toBe(logPath(1, b, 10, 20));
  const u = new URL('http://x' + logPath(1, a, 10, 20));
  expect(u.pathname).toBe('/chats/1/admin-log');
  expect(u.searchParams.get('before')).toBe('10');
  expect(u.searchParams.get('limit')).toBe('20');
  expect(u.searchParams.get('q')).toBe('а&б');
  expect(u.searchParams.get('actors')).toBe('2,5');
  expect(new URL('http://x' + logPath(1, NO_FILTER, null)).search).toBe('?limit=50');
});

test('what to show: list stays while offline; denied clears; empty differs with a filter', () => {
  const active: LogFilter = { ...NO_FILTER, q: 'а' };
  expect(logView({ entries: 3, status: 'offline' }, NO_FILTER)).toBe('list');
  expect(logView({ entries: 3, status: 'loading' }, NO_FILTER)).toBe('list');
  expect(logView({ entries: 3, status: 'denied' }, NO_FILTER)).toBe('denied');
  expect(logView({ entries: 0, status: 'ready' }, NO_FILTER)).toBe('empty');
  expect(logView({ entries: 0, status: 'ready' }, active)).toBe('emptyFiltered');
  expect(logView({ entries: 0, status: 'offline' }, NO_FILTER)).toBe('offline');
  expect(logView({ entries: 0, status: 'loading' }, NO_FILTER)).toBe('loading');
  expect(['offline', 'forbidden', 'not_member', 'not_found', 'internal'].map(logFailure)).toEqual(['offline', 'denied', 'denied', 'denied', 'error']);
});
