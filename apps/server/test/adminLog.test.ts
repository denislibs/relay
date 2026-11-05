import { afterAll, beforeEach, expect, test } from 'bun:test';
import { ADMIN_LOG_ACTIONS, ADMIN_LOG_GROUPS, normalizePoll, type AdminLogAction, type AdminLogPage } from '@relay/protocol';
import { clientProof, makeVerifier } from '@relay/protocol/src/srp';
import { sql } from '../src/db';
import { logAdminAction, maskInvite, trimAdminLog } from '../src/domain/adminLog';
import { adminLogPage } from '../src/domain/adminLogRead';
import { setAutoDelete } from '../src/domain/autoDelete';
import { setChatTheme } from '../src/domain/chatTheme';
import { createGroup } from '../src/domain/chats';
import { addGroupMembers, deleteGroup, removeGroupMember, restrictGroupMember, setGroupAdmin, setGroupPhoto, setGroupRank, setGroupRights, setGroupSettings, setGroupUsername, setLinkedChat, transferGroupOwnership, unbanGroupMember, updateGroupInfo } from '../src/domain/groups';
import { createInvite, decideRequests, deleteInvites, editInvite, joinByInvite, joinDiscussion } from '../src/domain/invites';
import { deleteMessage, editMessage } from '../src/domain/messageOps';
import { sendMessage } from '../src/domain/messages';
import { pinMessage, unpinMessage } from '../src/domain/pins';
import { closePoll } from '../src/domain/polls';
import { challengeFor, setPassword } from '../src/domain/password';
import { createServer } from '../src/http';
import { drainJobs } from '../src/jobs/worker';
import { ensurePeriodic } from '../src/jobs/queue';
import '../src/jobs/kinds';
import { makeChat, makeUser, resetDb } from './helpers';

const server = createServer({ port: 0 });
afterAll(() => { server.stop(true); });
beforeEach(resetDb);

type Kind = 'group' | 'channel';
const send = async (u: number, chatId: number, body: string) => (await sendMessage(u, { chatId, clientId: crypto.randomUUID(), body })).message;
const log = async (chat: number) => (await sql`select action, actor_id, data from admin_log where chat_id = ${chat} order by id`).map((r) => ({ action: r.action as AdminLogAction, actor: Number(r.actor_id), data: r.data as Record<string, unknown> }));
const page = (viewer: number, chat: number, q = '') => adminLogPage(viewer, chat, new URLSearchParams(q));
const RIGHTS = { info: true, post: true, edit: true, delete: true, ban: true, invite: true, pin: true, addAdmins: true };

/** Чат: владелец, админ со всеми правами, второй админ, два участника и посторонний. */
async function world(kind: Kind) {
  const o = await makeUser('Анна'), a = await makeUser('Борис'), a2 = await makeUser('Вера'), m = await makeUser('Гена'), m2 = await makeUser('Дина'), s = await makeUser('Чужой');
  const { chatId: chat } = await createGroup(o, { kind, title: 'Сообщество', about: 'Старое описание', memberIds: [a, a2, m, m2] });
  await setGroupAdmin(o, chat, a, { rights: RIGHTS });
  await setGroupAdmin(o, chat, a2, { rights: { ...RIGHTS, addAdmins: false } });
  await sql`delete from admin_log where chat_id = ${chat}`;   // подготовка в журнал теста не входит
  return { o, a, a2, m, m2, s, chat, kind };
}
type W = Awaited<ReturnType<typeof world>>;

async function photoIds(owner: number): Promise<{ id: string; small: string; thumb: string }> {
  const add = async (side: number) => (await sql`insert into attachments (owner_id, mime, name, size, status, kind, width, height, enc)
    values (${owner}, 'image/jpeg', 'p.jpg', 10, 'ready', 'photo', ${side}, ${side}, 0) returning id`)[0].id as string;
  return { id: await add(640), small: await add(160), thumb: 'data:image/jpeg;base64,' + 'A'.repeat(20) };
}
const poll = () => normalizePoll({ question: 'Куда едем?', options: ['Море', 'Горы'], multiple: false, quiz: false, anonymous: true })!;
const proof = async (u: number, pw = 'пароль') => { const c = await challengeFor(u); return { srpId: c.srpId, ...(await clientProof(pw, c.salt, c.B)) }; };

/** Одно действие на каждый тип записи: prepare — до снимка состояния, act — само действие. Канал там, где действие есть только у него. */
type Scenario = {
  action: AdminLogAction; kind?: Kind;
  prepare?: (w: W) => Promise<Record<string, any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  act: (w: W, p: Record<string, any>) => Promise<unknown>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  expect?: (w: W, p: Record<string, any>) => Record<string, unknown>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  actor?: (w: W) => number;
};
const SCENARIOS: Scenario[] = [
  { action: 'title_changed', act: (w) => updateGroupInfo(w.a, w.chat, { title: 'Новое' }), expect: () => ({ from: 'Сообщество', to: 'Новое' }) },
  { action: 'about_changed', act: (w) => updateGroupInfo(w.a, w.chat, { about: 'Новое описание' }), expect: () => ({ from: 'Старое описание', to: 'Новое описание' }) },
  { action: 'photo_changed', prepare: async (w) => ({ ph: await photoIds(w.a) }), act: (w, p) => setGroupPhoto(w.a, w.chat, p.ph) },
  { action: 'photo_removed', prepare: async (w) => { await setGroupPhoto(w.a, w.chat, await photoIds(w.a)); return {}; }, act: (w) => setGroupPhoto(w.a, w.chat, null) },
  { action: 'username_changed', act: (w) => setGroupUsername(w.o, w.chat, 'publicname'), actor: (w) => w.o, expect: () => ({ from: null, to: 'publicname' }) },
  { action: 'signatures_toggled', kind: 'channel', act: (w) => setGroupSettings(w.a, w.chat, { signatures: true }), expect: () => ({ on: true }) },
  { action: 'protected_toggled', act: (w) => setGroupSettings(w.o, w.chat, { protected: true }), actor: (w) => w.o, expect: () => ({ on: true }) },
  { action: 'theme_changed', act: (w) => setChatTheme(w.a, w.chat, 'chick'), expect: () => ({ from: null, to: { emoji: '🐥', title: 'Цыплёнок' } }) },
  { action: 'auto_delete_changed', act: (w) => setAutoDelete(w.a, w.chat, 86400), expect: () => ({ from: null, to: 86400 }) },
  { action: 'slow_mode_changed', act: (w) => setGroupRights(w.a, w.chat, { slowMode: 60 }), expect: () => ({ from: 0, to: 60 }) },
  { action: 'history_toggled', act: (w) => setGroupSettings(w.a, w.chat, { historyHidden: true }), expect: () => ({ hidden: true }) },
  { action: 'join_approval_toggled', act: (w) => setGroupSettings(w.a, w.chat, { joinApproval: true }), expect: () => ({ on: true }) },
  { action: 'join_to_send_toggled', act: (w) => setGroupSettings(w.a, w.chat, { joinToSend: true }), expect: () => ({ on: true }) },
  { action: 'linked_chat_changed', kind: 'channel',
    prepare: async (w) => ({ g: (await createGroup(w.o, { kind: 'group', title: 'Обсуждение', memberIds: [w.m2] })).chatId }),
    act: (w, p) => setLinkedChat(w.o, w.chat, p.g), actor: (w) => w.o, expect: (_, p) => ({ from: null, to: p.g }) },
  { action: 'reactions_changed', act: (w) => setGroupSettings(w.a, w.chat, { reactions: { mode: 'none' } }), expect: () => ({ to: { mode: 'none', allowed: [] } }) },
  { action: 'default_rights_changed', act: (w) => setGroupRights(w.a, w.chat, { rights: { text: true, photos: false } }), expect: () => ({ to: { photos: false } }) },
  { action: 'member_added', prepare: async (w) => ({ u: await makeUser('Новичок') }), act: (w, p) => addGroupMembers(w.a, w.chat, [p.u]), expect: (_, p) => ({ target: p.u }) },
  { action: 'member_joined', prepare: async (w) => ({ inv: await createInvite(w.a, w.chat, {}) }), act: (w, p) => joinByInvite(w.s, p.inv.link), actor: (w) => w.s, expect: (w, p) => ({ target: w.s, via: 'link', mask: maskInvite(p.inv.link) }) },
  { action: 'member_left', act: (w) => removeGroupMember(w.m, w.chat, w.m), actor: (w) => w.m, expect: (w) => ({ target: w.m }) },
  { action: 'member_banned', act: (w) => removeGroupMember(w.a, w.chat, w.m), expect: (w) => ({ target: w.m }) },
  { action: 'member_unbanned', prepare: async (w) => { await removeGroupMember(w.a, w.chat, w.m); return {}; }, act: (w) => unbanGroupMember(w.a, w.chat, w.m), expect: (w) => ({ target: w.m }) },
  { action: 'member_restricted', act: (w) => restrictGroupMember(w.a, w.chat, w.m, { text: false }), expect: (w) => ({ target: w.m, from: { text: true }, to: { text: false } }) },
  { action: 'member_unrestricted', prepare: async (w) => { await restrictGroupMember(w.a, w.chat, w.m, { text: false }); return {}; }, act: (w) => restrictGroupMember(w.a, w.chat, w.m, null), expect: (w) => ({ target: w.m }) },
  { action: 'request_approved',
    prepare: async (w) => { const inv = await createInvite(w.a, w.chat, { approval: true }); await joinByInvite(w.s, inv.link); return {}; },
    act: (w) => decideRequests(w.a, w.chat, w.s, true), expect: (w) => ({ target: w.s }) },
  { action: 'request_declined',
    prepare: async (w) => { const inv = await createInvite(w.a, w.chat, { approval: true }); await joinByInvite(w.s, inv.link); return {}; },
    act: (w) => decideRequests(w.a, w.chat, w.s, false), expect: (w) => ({ target: w.s }) },
  { action: 'admin_promoted', act: (w) => setGroupAdmin(w.a, w.chat, w.m, { rights: { pin: true }, rank: 'Модератор' }), expect: (w) => ({ target: w.m, rank: 'Модератор' }) },
  { action: 'admin_edited', act: (w) => setGroupAdmin(w.o, w.chat, w.a2, { rights: { pin: true } }), actor: (w) => w.o, expect: (w) => ({ target: w.a2 }) },
  { action: 'admin_demoted', act: (w) => setGroupAdmin(w.o, w.chat, w.a2, { rights: null }), actor: (w) => w.o, expect: (w) => ({ target: w.a2 }) },
  { action: 'admin_rank_changed', act: (w) => setGroupRank(w.o, w.chat, w.a2, 'Глава'), actor: (w) => w.o, expect: (w) => ({ target: w.a2, from: null, to: 'Глава' }) },
  { action: 'owner_transferred', prepare: async (w) => { await setPassword(w.o, { next: await makeVerifier('пароль') }); return {}; }, act: async (w) => transferGroupOwnership(w.o, w.chat, w.a, await proof(w.o)), actor: (w) => w.o, expect: (w) => ({ target: w.a }) },
  { action: 'message_deleted', prepare: async (w) => ({ msg: await send(w.m, w.chat, 'чужое') }), act: (w, p) => deleteMessage(w.a, w.chat, p.msg.id), expect: (w, p) => ({ messageId: p.msg.id, target: w.m }) },
  { action: 'message_edited', kind: 'channel', prepare: async (w) => ({ msg: await send(w.o, w.chat, 'пост') }), act: (w, p) => editMessage(w.a, w.chat, p.msg.id, 'правка'), expect: (w, p) => ({ messageId: p.msg.id, target: w.o }) },
  { action: 'message_pinned', prepare: async (w) => ({ msg: await send(w.m, w.chat, 'закреп') }), act: (w, p) => pinMessage(w.a, w.chat, p.msg.id), expect: (w, p) => ({ messageId: p.msg.id, target: w.m }) },
  { action: 'message_unpinned', prepare: async (w) => { const msg = await send(w.m, w.chat, 'закреп'); await pinMessage(w.a, w.chat, msg.id); return { msg }; }, act: (w, p) => unpinMessage(w.a, w.chat, p.msg.id), expect: (w, p) => ({ messageId: p.msg.id }) },
  { action: 'all_unpinned', prepare: async (w) => { const msg = await send(w.m, w.chat, 'закреп'); await pinMessage(w.a, w.chat, msg.id); return {}; }, act: (w) => unpinMessage(w.a, w.chat, null), expect: () => ({ count: 1 }) },
  { action: 'poll_closed', kind: 'channel', prepare: async (w) => ({ msg: (await sendMessage(w.o, { chatId: w.chat, clientId: crypto.randomUUID(), body: '', poll: poll() })).message }), act: (w, p) => closePoll(w.a, w.chat, p.msg.id), expect: (w, p) => ({ messageId: p.msg.id, target: w.o }) },
  { action: 'invite_created', act: (w) => createInvite(w.a, w.chat, { title: 'Соседи' }), expect: () => ({ title: 'Соседи', approval: false }) },
  { action: 'invite_edited', prepare: async (w) => ({ inv: await createInvite(w.a, w.chat, { title: 'Было' }) }), act: (w, p) => editInvite(w.a, w.chat, p.inv.id, { title: 'Стало' }), expect: (_, p) => ({ inviteId: p.inv.id, mask: maskInvite(p.inv.link) }) },
  { action: 'invite_revoked', prepare: async (w) => ({ inv: await createInvite(w.a, w.chat, {}) }), act: (w, p) => editInvite(w.a, w.chat, p.inv.id, { revoked: true }), expect: (_, p) => ({ inviteId: p.inv.id, mask: maskInvite(p.inv.link) }) },
  { action: 'invite_deleted', prepare: async (w) => { const inv = await createInvite(w.a, w.chat, {}); await editInvite(w.a, w.chat, inv.id, { revoked: true }); return { inv }; }, act: (w, p) => deleteInvites(w.a, w.chat, p.inv.id), expect: (_, p) => ({ inviteId: p.inv.id, mask: maskInvite(p.inv.link) }) },
];

/** Состояние чата целиком: что могло поменяться действием. */
async function stateOf(chat: number) {
  return JSON.stringify(await Promise.all([
    sql`select * from chats where id = ${chat}`,
    sql`select user_id, role, admin_rights, rank, restricted, promoted_by from chat_members where chat_id = ${chat} order by user_id`,
    sql`select user_id from chat_bans where chat_id = ${chat} order by user_id`,
    sql`select id, title, revoked from chat_invites where chat_id = ${chat} order by id`,
    sql`select user_id from chat_join_requests where chat_id = ${chat} order by user_id`,
    sql`select message_id from pinned_messages where chat_id = ${chat} order by message_id`,
    sql`select id, deleted, edited_at, content from messages where chat_id = ${chat} order by id`,
    sql`select count(*)::int as n from admin_log where chat_id = ${chat}`,
  ]));
}

test('every action type has a scenario below', () => {
  expect(SCENARIOS.map((s) => s.action).sort()).toEqual([...ADMIN_LOG_ACTIONS].sort());
  expect(new Set(ADMIN_LOG_ACTIONS).size).toBe(ADMIN_LOG_ACTIONS.length);
});

for (const sc of SCENARIOS) {
  test(`${sc.action}: written by the action; if the commit fails, neither the change nor the row remains`, async () => {
    // откат: у записи журнала отложенная проверка падает при коммите. Запись не в той транзакции осталась бы или действие прошло бы
    const w = await world(sc.kind ?? 'group');
    const p = sc.prepare ? await sc.prepare(w) : {};
    await sql`delete from admin_log where chat_id = ${w.chat}`;
    const before = await stateOf(w.chat);
    await sql.unsafe(`create or replace function admin_log_fail() returns trigger language plpgsql as $$ begin raise exception 'журнал недоступен'; end $$;
                      create constraint trigger admin_log_fail after insert on admin_log deferrable initially deferred for each row execute function admin_log_fail();`);
    try {
      await expect(sc.act(w, p)).rejects.toThrow();
    } finally { await sql.unsafe(`drop trigger admin_log_fail on admin_log; drop function admin_log_fail();`); }
    expect(await stateOf(w.chat)).toBe(before);
    // обычный путь: ровно эта запись, с исполнителем и данными
    await sc.act(w, p);
    const rows = await log(w.chat);
    const row = rows.find((r) => r.action === sc.action);
    expect(row).toBeDefined();
    expect(row!.actor).toBe((sc.actor ?? ((x: W) => x.a))(w));
    if (sc.expect) expect(row!.data).toMatchObject(sc.expect(w, p));
  });
}

test('a failing transaction leaves no row even after the helper was called', async () => {
  const w = await world('group');
  await expect(sql.begin(async (tx) => { await logAdminAction(tx, w.chat, w.o, 'photo_removed', {}); throw new Error('откат'); })).rejects.toThrow('откат');
  expect(await log(w.chat)).toEqual([]);
});

test('who can read: any admin and the owner; member, stranger, ex-admin and left admin are refused — over HTTP too', async () => {
  for (const kind of ['group', 'channel'] as const) {
    const w = await world(kind);
    await updateGroupInfo(w.a, w.chat, { title: 'Новое' });
    for (const u of [w.o, w.a, w.a2]) expect((await page(u, w.chat)).entries.map((e) => e.action)).toEqual(['title_changed']);
    await expect(page(w.m, w.chat)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(page(w.s, w.chat)).rejects.toMatchObject({ code: 'not_member' });
    // снятый с поста — сразу
    await setGroupAdmin(w.o, w.chat, w.a2, { rights: null });
    await expect(page(w.a2, w.chat)).rejects.toMatchObject({ code: 'forbidden' });
    // админ вышел — сразу
    await removeGroupMember(w.a, w.chat, w.a);
    await expect(page(w.a, w.chat)).rejects.toMatchObject({ code: 'not_member' });
  }
  const w = await world('group');
  // участник со скрытой историей — обычный участник: отказ
  await setGroupSettings(w.o, w.chat, { historyHidden: true });
  const late = await makeUser('Поздний');
  await addGroupMembers(w.o, w.chat, [late]);
  await sql`update chat_members set history_from = 999 where chat_id = ${w.chat} and user_id = ${late}`;
  await expect(page(late, w.chat)).rejects.toMatchObject({ code: 'forbidden' });
  // без входа — 401; ответ отдаётся без кэша
  const res = await fetch(`http://localhost:${server.port}/chats/${w.chat}/admin-log`);
  expect(res.status).toBe(401);
});

test('an admin with hidden history: entries about hidden messages lose the reference and the author', async () => {
  const w = await world('group');
  const old = await send(w.m, w.chat, 'старое');
  await pinMessage(w.o, w.chat, old.id);
  await deleteMessage(w.o, w.chat, (await send(w.m2, w.chat, 'ещё старое')).id);
  await sql`update chat_members set history_from = ${old.id + 1000} where chat_id = ${w.chat} and user_id = ${w.a}`;
  const { entries } = await page(w.a, w.chat);
  for (const e of entries) if (e.action === 'message_pinned' || e.action === 'message_deleted') {
    expect(e.data).toEqual({ hidden: true } as never);
    expect(e.message ?? null).toBeNull();
  }
  expect(JSON.stringify(entries)).not.toContain('старое');
  // владельцу те же записи видны со ссылкой и текстом закрепа
  const mine = (await page(w.o, w.chat)).entries.find((e) => e.action === 'message_pinned')!;
  expect(mine.message).toMatchObject({ id: old.id, body: 'старое' });
});

test('own message actions of a member stay out; own message of an admin: pin yes, delete/edit no', async () => {
  const w = await world('group');
  const mine = await send(w.m, w.chat, 'моё');
  await editMessage(w.m, w.chat, mine.id, 'моё, правка');
  await deleteMessage(w.m, w.chat, mine.id);
  const adminOwn = await send(w.a, w.chat, 'админа');
  await deleteMessage(w.a, w.chat, adminOwn.id);
  expect(await log(w.chat)).toEqual([]);
  // участнику разрешено закреплять: своё — не в журнале, чужое — да
  await setGroupRights(w.o, w.chat, { rights: { text: true, pin: true } });
  await sql`delete from admin_log where chat_id = ${w.chat}`;
  const own = await send(w.m, w.chat, 'закрепляю своё'), other = await send(w.m2, w.chat, 'чужое');
  await pinMessage(w.m, w.chat, own.id);
  await unpinMessage(w.m, w.chat, own.id);
  expect(await log(w.chat)).toEqual([]);
  await pinMessage(w.m, w.chat, other.id);
  expect((await log(w.chat)).map((r) => r.action)).toEqual(['message_pinned']);
  // админ своё закрепляет как админ
  const ad = await send(w.a, w.chat, 'моё админское');
  await pinMessage(w.a, w.chat, ad.id);
  expect((await log(w.chat)).map((r) => r.action)).toEqual(['message_pinned', 'message_pinned']);
  // канал: свой пост — не в журнале; опрос свой — тоже
  const c = await world('channel');
  const post = await send(c.a, c.chat, 'свой пост');
  await editMessage(c.a, c.chat, post.id, 'правка своего');
  const pl = (await sendMessage(c.a, { chatId: c.chat, clientId: crypto.randomUUID(), body: '', poll: poll() })).message;
  await closePoll(c.a, c.chat, pl.id);
  await deleteMessage(c.a, c.chat, post.id);
  expect(await log(c.chat)).toEqual([]);
});

test('direct chats are not logged; a repeat without a change writes nothing', async () => {
  const a = await makeUser('Анна'), b = await makeUser('Борис');
  const dm = await makeChat([a, b]);
  await setChatTheme(a, dm, 'chick');
  await setAutoDelete(a, dm, 86400);
  await pinMessage(a, dm, (await send(b, dm, 'привет')).id);
  await deleteMessage(a, dm, (await send(a, dm, 'пока')).id);
  expect(await log(dm)).toEqual([]);

  const w = await world('group');
  const msg = await send(w.m, w.chat, 'закреп');
  const twice: [string, () => Promise<unknown>][] = [
    ['title', () => updateGroupInfo(w.a, w.chat, { title: 'Новое' })],
    ['about', () => updateGroupInfo(w.a, w.chat, { about: 'Опис' })],
    ['rights', () => setGroupRights(w.a, w.chat, { rights: { text: true }, slowMode: 30 })],
    ['settings', () => setGroupSettings(w.o, w.chat, { historyHidden: true, joinApproval: true, protected: true, reactions: { mode: 'some', allowed: ['👍', '❤️'] } })],
    ['username', () => setGroupUsername(w.o, w.chat, 'PublicName')],
    ['theme', () => setChatTheme(w.a, w.chat, 'chick')],
    ['auto-delete', () => setAutoDelete(w.a, w.chat, 86400)],
    ['restrict', () => restrictGroupMember(w.a, w.chat, w.m, { text: false })],
    ['admin', () => setGroupAdmin(w.o, w.chat, w.a2, { rights: { pin: true }, rank: 'Глава' })],
    ['rank', () => setGroupRank(w.o, w.chat, w.a2, 'Глава')],
    ['pin', () => pinMessage(w.a, w.chat, msg.id)],
  ];
  for (const [name, f] of twice) {
    await f();
    const n = (await log(w.chat)).length;
    expect([name, n > 0]).toEqual([name, true]);
    await f();
    expect([name, (await log(w.chat)).length]).toEqual([name, n]);
  }
  // снятие не-админа, снятие бана у незабаненного и открепление незакреплённого — ни к чему
  const n = (await log(w.chat)).length;
  await setGroupAdmin(w.o, w.chat, w.m2, { rights: null });
  await unbanGroupMember(w.o, w.chat, w.s);
  await unpinMessage(w.a, w.chat, msg.id + 100);
  expect((await log(w.chat)).length).toBe(n);
});

test('several records of one transaction keep their order', async () => {
  // ban → добавление: снятие бана, потом добавление
  const w = await world('group');
  await removeGroupMember(w.a, w.chat, w.m);
  await sql`delete from admin_log where chat_id = ${w.chat}`;
  await addGroupMembers(w.a, w.chat, [w.m]);
  expect((await log(w.chat)).map((r) => r.action)).toEqual(['member_unbanned', 'member_added']);
  // владелец выходит: права перешли, потом вышел
  await sql`delete from admin_log where chat_id = ${w.chat}`;
  await removeGroupMember(w.o, w.chat, w.o);
  expect((await log(w.chat)).map((r) => [r.action, r.actor, r.data.auto ?? null])).toEqual([['owner_transferred', w.o, true], ['member_left', w.o, null]]);
  // отзыв основной ссылки: отзыв, потом новая основная (создание при чтении списка — не действие)
  const g = await world('group');
  const [{ id }] = await sql`insert into chat_invites (chat_id, token, creator_id, primary_link) values (${g.chat}, 'tok-primary-0000', ${g.o}, true) returning id`;
  await editInvite(g.a, g.chat, Number(id), { revoked: true });
  expect((await log(g.chat)).map((r) => r.action)).toEqual(['invite_revoked', 'invite_created']);
  // выключили одобрение: настройка, потом заявки
  const j = await world('group');
  await setGroupSettings(j.a, j.chat, { joinApproval: true });
  const inv = await createInvite(j.a, j.chat, { approval: true });
  await joinByInvite(j.s, inv.link);
  await sql`delete from admin_log where chat_id = ${j.chat}`;
  await setGroupSettings(j.a, j.chat, { joinApproval: false });
  expect((await log(j.chat)).map((r) => [r.action, r.actor])).toEqual([['join_approval_toggled', j.a], ['request_approved', j.a]]);
  // привязка: и у канала, и у группы; скрытая история группы выключилась следом
  const ch = await world('channel');
  const { chatId: gr } = await createGroup(ch.o, { kind: 'group', title: 'Обсуждение', memberIds: [ch.m2] });
  await setGroupSettings(ch.o, gr, { historyHidden: true });
  await sql`delete from admin_log where chat_id = ${gr}`;
  await setLinkedChat(ch.o, ch.chat, gr);
  expect((await log(gr)).map((r) => r.action)).toEqual(['linked_chat_changed', 'history_toggled']);
  expect((await log(ch.chat)).at(-1)?.data).toMatchObject({ from: null, to: gr });
  // удаление группы отвязывает канал: запись у канала, а журнал группы стёрт
  await deleteGroup(ch.o, gr);
  expect((await log(ch.chat)).at(-1)).toMatchObject({ action: 'linked_chat_changed', data: { from: gr, to: null } });
  expect(await log(gr)).toEqual([]);
});

test('joining: by link, by username, from a thread; channel too; banned rejoin does not log', async () => {
  const w = await world('channel');
  await setGroupUsername(w.o, w.chat, 'publicname');
  await joinByInvite(w.s, '@publicname');
  expect((await log(w.chat)).at(-1)).toMatchObject({ action: 'member_joined', actor: w.s, data: { target: w.s, via: 'username' } });
  const { chatId: gr } = await createGroup(w.o, { kind: 'group', title: 'Обсуждение', memberIds: [w.m2] });
  await setLinkedChat(w.o, w.chat, gr);
  await joinDiscussion(w.m, gr);
  expect((await log(gr)).at(-1)).toMatchObject({ action: 'member_joined', data: { target: w.m, via: 'discussion' } });
  const before = (await log(gr)).length;
  await joinDiscussion(w.m, gr);   // уже в группе
  expect((await log(gr)).length).toBe(before);
});

test('no message text, no invite token, in the table or in the response', async () => {
  const w = await world('group');
  const secret = 'тайна-удалённого-сообщения', quote = 'тайна-закрепа';
  const del = await send(w.m, w.chat, secret), pin = await send(w.m, w.chat, quote);
  await deleteMessage(w.a, w.chat, del.id);
  await pinMessage(w.a, w.chat, pin.id);
  const inv = await createInvite(w.a, w.chat, { title: 'Соседи' });
  await editInvite(w.a, w.chat, inv.id, { title: 'Друзья' });
  await joinByInvite(w.s, inv.link);
  await editInvite(w.a, w.chat, inv.id, { revoked: true });
  await deleteInvites(w.a, w.chat, inv.id);
  const dump = JSON.stringify(await sql`select * from admin_log where chat_id = ${w.chat}`);
  for (const bad of [secret, quote, inv.link]) expect(dump).not.toContain(bad);
  expect(dump).toContain(maskInvite(inv.link));
  // запись об удалённом: автор, id, дата; текст ниоткуда не подставляется
  const p = await page(w.o, w.chat);
  const d = p.entries.find((e) => e.action === 'message_deleted')!;
  expect(d.data).toEqual({ messageId: del.id, target: w.m, at: del.createdAt } as never);
  expect(d.message).toBeUndefined();
  const shown = JSON.stringify(p);
  expect(shown).not.toContain(secret);
  expect(shown).not.toContain(inv.link);
  expect(shown).toContain(quote);   // закреп — живое сообщение: текст тем же чтением
});

test('a message reference shows text only while the message is readable', async () => {
  const w = await world('group');
  const m1 = await send(w.m, w.chat, 'будет удалено'), m2 = await send(w.m, w.chat, 'срок вышел');
  await pinMessage(w.a, w.chat, m1.id);
  await pinMessage(w.a, w.chat, m2.id);
  const texts = async () => (await page(w.a, w.chat)).entries.filter((e) => e.action === 'message_pinned').map((e) => [(e.data as { messageId: number }).messageId, e.message?.body ?? null]);
  expect(await texts()).toEqual([[m2.id, 'срок вышел'], [m1.id, 'будет удалено']]);
  await deleteMessage(w.m, w.chat, m1.id);   // своё: без записи, но ссылка из журнала больше не открывается
  await sql`update messages set expires_at = now() - interval '1 second' where id = ${m2.id}`;
  expect(await texts()).toEqual([[m2.id, null], [m1.id, null]]);
});

test('a message preview keeps spoilers hidden and is clipped; a comment reference carries its thread', async () => {
  const w = await world('group');
  const { message } = await sendMessage(w.m, { chatId: w.chat, clientId: crypto.randomUUID(), body: 'пароль: секрет ' + 'х'.repeat(300), entities: [{ type: 'spoiler', offset: 8, length: 6 }] });
  await pinMessage(w.a, w.chat, message.id);
  const e = (await page(w.a, w.chat)).entries[0];
  expect(e.message!.body).not.toContain('секрет');
  expect(e.message!.body.length).toBeLessThanOrEqual(160);
  // комментарий: ссылка ведёт в тред
  const c = await world('channel');
  const { chatId: gr } = await createGroup(c.o, { kind: 'group', title: 'Обсуждение', memberIds: [c.m2] });
  await setLinkedChat(c.o, c.chat, gr);
  await send(c.o, c.chat, 'пост');
  await drainJobs();
  const [copy] = await sql`select id from messages where chat_id = ${gr} and origin is not null`;
  const { message: comment } = await sendMessage(c.m2, { chatId: gr, clientId: crypto.randomUUID(), body: 'комментарий', threadId: Number(copy.id) });
  await pinMessage(c.o, gr, comment.id);
  expect((await page(c.o, gr)).entries[0].message).toMatchObject({ id: comment.id, threadId: Number(copy.id) });
});

test('retention: older than 48 hours is not served before the job runs; the job removes it, and is periodic', async () => {
  const w = await world('group');
  await updateGroupInfo(w.a, w.chat, { title: 'Старое действие' });
  await updateGroupInfo(w.a, w.chat, { about: 'Свежее действие' });
  const rows = await sql`select id from admin_log where chat_id = ${w.chat} order by id`;
  await sql`update admin_log set at = now() - interval '48 hours 1 second' where id = ${rows[0].id}`;
  expect((await page(w.a, w.chat)).entries.map((e) => e.action)).toEqual(['about_changed']);
  expect((await log(w.chat)).length).toBe(2);   // ещё лежит: чтение отсекло само
  await sql`update admin_log set at = now() - interval '47 hours' where id = ${rows[1].id}`;
  expect((await page(w.a, w.chat)).entries.length).toBe(1);
  await ensurePeriodic('adminLog.trim');
  await drainJobs();
  expect((await log(w.chat)).map((r) => r.action)).toEqual(['about_changed']);
  const [job] = await sql`select run_at > now() as later from jobs where kind = 'adminLog.trim'`;
  expect(job.later).toBe(true);   // переставлена на следующий проход
  expect(await trimAdminLog()).toBe(0);
});

test('deleting a chat wipes its log at once; reading it is not_found', async () => {
  const w = await world('group');
  await updateGroupInfo(w.a, w.chat, { title: 'Новое' });
  await deleteGroup(w.o, w.chat);
  expect(await log(w.chat)).toEqual([]);
  await expect(page(w.o, w.chat)).rejects.toMatchObject({ code: 'not_found' });
  await drainJobs();   // chat.purge
  const [gone] = await sql`select 1 from chats where id = ${w.chat}`;
  expect(gone).toBeUndefined();
  // последний владелец вышел: чат удалён тем же путём
  const o = await makeUser('Один');
  const { chatId } = await createGroup(o, { kind: 'group', title: 'Один', memberIds: [w.m] });
  await updateGroupInfo(o, chatId, { title: 'Два' });
  await removeGroupMember(w.m, chatId, w.m);
  await removeGroupMember(o, chatId, o);
  expect(await log(chatId)).toEqual([]);
});

test('pagination by id without gaps or repeats; hasMore; limit is capped', async () => {
  const w = await world('group');
  for (let i = 0; i < 7; i++) await updateGroupInfo(w.a, w.chat, { title: 'Название ' + i });
  const seen: number[] = [];
  let before: number | null = null;
  for (let n = 0; n < 5; n++) {
    const p: AdminLogPage = await page(w.a, w.chat, `limit=3${before ? `&before=${before}` : ''}`);
    seen.push(...p.entries.map((e) => e.id));
    if (!p.hasMore) { expect(n).toBe(2); break; }
    before = p.entries.at(-1)!.id;
  }
  expect(seen).toHaveLength(7);
  expect(seen).toEqual([...seen].sort((a, b) => b - a));
  expect(new Set(seen).size).toBe(7);
  expect((await page(w.a, w.chat, 'limit=100000')).entries.length).toBe(7);
  for (const bad of ['before=abc', 'limit=-1', 'actions=hack', 'actors=x', `q=${'я'.repeat(65)}`]) await expect(page(w.a, w.chat, bad)).rejects.toBeDefined();
  // чужой чат через before не читается: граница по chat_id
  const other = await world('group');
  await updateGroupInfo(other.a, other.chat, { title: 'Чужое' });
  expect((await page(w.a, w.chat)).entries.every((e) => e.action === 'title_changed' && !JSON.stringify(e).includes('Чужое'))).toBe(true);
});

test('filters: actions, actors, q by actor name and type; combined; wildcards are literal', async () => {
  const w = await world('group');
  await updateGroupInfo(w.a, w.chat, { title: 'Новое' });
  await updateGroupInfo(w.a2, w.chat, { about: 'Опис' });
  await removeGroupMember(w.a, w.chat, w.m);
  const actions = async (q: string) => (await page(w.o, w.chat, q)).entries.map((e) => e.action);
  expect(await actions(`actions=${ADMIN_LOG_GROUPS.members.join(',')}`)).toEqual(['member_banned']);
  expect(await actions('actions=title_changed,about_changed')).toEqual(['about_changed', 'title_changed']);
  expect(await actions(`actors=${w.a2}`)).toEqual(['about_changed']);
  expect(await actions(`actors=${w.a},${w.a2}&actions=about_changed`)).toEqual(['about_changed']);
  expect(await actions(`q=${encodeURIComponent('борис')}`)).toEqual(['member_banned', 'title_changed']);
  expect(await actions(`q=${encodeURIComponent('Описание')}`)).toEqual(['about_changed']);   // по названию типа
  expect(await actions('q=%25')).toEqual([]);
  expect(await actions(`q=${encodeURIComponent('Новое')}`)).toEqual([]);   // по значениям не ищем
  // имя — глазами читателя: контактное имя тоже находит
  await sql`insert into contacts (owner_id, user_id, first_name, last_name) values (${w.o}, ${w.a}, 'Боб', 'Контакт')`;
  expect(await actions(`q=${encodeURIComponent('контакт')}`)).toEqual(['member_banned', 'title_changed']);
});

test('names are read by id at read time; a deleted actor or target is neutral; photo hidden from the blocked', async () => {
  const w = await world('channel');   // у канала нет служебных сообщений от участника: строку пользователя можно удалить
  await removeGroupMember(w.a, w.chat, w.m);
  await sql`update users set name = 'Боря' where id = ${w.a}`;
  const p = await page(w.o, w.chat);
  expect(p.users.find((u) => u.id === w.a)).toMatchObject({ name: 'Боря' });
  expect(p.users.find((u) => u.id === w.a)!.key).toBeTruthy();
  expect(JSON.stringify(await sql`select data from admin_log where chat_id = ${w.chat}`)).not.toContain('Гена');   // имена в журнале не лежат
  await sql`delete from users where id = ${w.m}`;
  const q = await page(w.o, w.chat);
  expect(q.users.find((u) => u.id === w.m)).toEqual({ id: w.m, name: null, photo: null });
  await sql`update users set photo = '{"id":"x"}'::jsonb where id = ${w.a}`;
  expect((await page(w.o, w.chat)).users.find((u) => u.id === w.a)!.photo).toBeTruthy();
  await sql`insert into blocks (owner_id, user_id) values (${w.a}, ${w.o})`;
  expect((await page(w.o, w.chat)).users.find((u) => u.id === w.a)!.photo).toBeNull();
  await sql`delete from users where id = ${w.a}`;
  expect((await page(w.o, w.chat)).entries[0].actorId).toBeNull();   // ON DELETE SET NULL
});

test('linked chat title only when the viewer can see it', async () => {
  const w = await world('channel');
  const stranger = await makeUser('Владелец группы');
  const { chatId: gr } = await createGroup(w.o, { kind: 'group', title: 'Обсуждение', memberIds: [stranger] });
  await setLinkedChat(w.o, w.chat, gr);
  expect((await page(w.a, w.chat)).chats).toEqual([{ id: gr, title: 'Обсуждение' }]);   // сейчас связана с этим каналом: видна и не участнику
  await setLinkedChat(w.o, w.chat, null);
  expect((await page(w.a, w.chat)).chats).toEqual([]);   // отвязана, админ канала в ней не состоит
  expect((await page(w.o, w.chat)).chats).toEqual([{ id: gr, title: 'Обсуждение' }]);   // владелец в ней состоит
});
