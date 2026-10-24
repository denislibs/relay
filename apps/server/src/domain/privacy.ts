import { defaultPrivacy, PRIVACY_KEYS, type PrivacyKey, type PrivacyMode, type PrivacyRule, type PrivacyRules } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';

type Db = Tx | typeof sql;

/** Сколько исключений в одном списке. */
export const MAX_EXCEPTIONS = 1000;
const MODES: readonly PrivacyMode[] = ['everyone', 'contacts', 'nobody'];

/**
 * Всё, что нужно для проверок на набор пар (зритель, владелец): правила владельцев, «владелец добавил зрителя
 * в контакты», «владелец заблокировал зрителя». Грузится тремя запросами на любой размер набора — без N+1.
 */
export interface PrivacyCtx {
  rules: Map<number, PrivacyRules>;
  contacts: Set<string>;
  blocks: Set<string>;
}
const pair = (owner: number, user: number) => owner + ':' + user;

type RuleRow = { user_id: number; key: PrivacyKey; mode: PrivacyMode; allow: unknown[]; deny: unknown[] };
const ids = (a: unknown[] | null) => (a ?? []).map(Number);

function fill(rows: RuleRow[], into: Map<number, PrivacyRules>): void {
  for (const r of rows) {
    const id = Number(r.user_id);
    let rules = into.get(id);
    if (!rules) { rules = defaultPrivacy(); into.set(id, rules); }
    rules[r.key] = { mode: r.mode, allow: ids(r.allow), deny: ids(r.deny) };
  }
}

/** Контекст для пар [зритель, владелец]; обратные пары (взаимность «Последнего визита») — тоже. */
export async function privacyCtx(db: Db, pairs: [number, number][]): Promise<PrivacyCtx> {
  const ctx: PrivacyCtx = { rules: new Map(), contacts: new Set(), blocks: new Set() };
  const ps = pairs.filter(([v, o]) => v !== o);
  if (!ps.length) return ctx;
  const people = [...new Set(ps.flat())];
  const a = ps.flatMap(([v, o]) => [o, v]), b = ps.flatMap(([v, o]) => [v, o]);   // обе стороны каждой пары
  const [rules, contacts, blocks] = await Promise.all([
    db<RuleRow[]>`select user_id, key, mode, allow, deny from privacy_rules where user_id = any(${people}::bigint[])`,
    db`select owner_id, user_id from contacts where (owner_id, user_id) in (select * from unnest(${a}::bigint[], ${b}::bigint[]))`,
    db`select owner_id, user_id from blocks where (owner_id, user_id) in (select * from unnest(${a}::bigint[], ${b}::bigint[]))`,
  ]);
  fill(rules, ctx.rules);
  for (const r of contacts) ctx.contacts.add(pair(Number(r.owner_id), Number(r.user_id)));
  for (const r of blocks) ctx.blocks.add(pair(Number(r.owner_id), Number(r.user_id)));
  return ctx;
}

const ruleOf = (ctx: PrivacyCtx, owner: number, key: PrivacyKey): PrivacyRule => ctx.rules.get(owner)?.[key] ?? defaultPrivacy()[key];

/** Только правило (без чёрного списка): deny > allow > mode. */
function allowedByRule(viewer: number, owner: number, key: PrivacyKey, ctx: PrivacyCtx): boolean {
  if (viewer === owner) return true;
  const r = ruleOf(ctx, owner, key);
  if (r.deny.includes(viewer)) return false;
  if (r.allow.includes(viewer)) return true;
  if (r.mode === 'everyone') return true;
  if (r.mode === 'contacts') return ctx.contacts.has(pair(owner, viewer));
  return false;
}

/**
 * Единственная проверка приватности: видит ли viewer поле key пользователя owner.
 * Свои — всегда; заблокированный владельцем не видит ничего из скрываемого; дальше — правило владельца.
 */
export function canSee(viewer: number, owner: number, key: PrivacyKey, ctx: PrivacyCtx): boolean {
  if (viewer === owner) return true;
  if (key !== 'phoneDiscovery' && ctx.blocks.has(pair(owner, viewer))) return false;
  return allowedByRule(viewer, owner, key, ctx);
}

/** «Последний визит и в сети»: правило владельца и взаимность — кто не показывает своё время зрителю, не видит и его. */
export function canSeeLastSeen(viewer: number, owner: number, ctx: PrivacyCtx): boolean {
  return canSee(viewer, owner, 'lastSeen', ctx) && allowedByRule(owner, viewer, 'lastSeen', ctx);
}

/** «Кто найдёт меня по номеру». */
export function canFindByPhone(viewer: number, owner: number, ctx: PrivacyCtx): boolean {
  return canSee(viewer, owner, 'phoneDiscovery', ctx);
}

/** Правила пользователя целиком (умолчания — где строки нет). */
export async function getRules(db: Db, userId: number): Promise<PrivacyRules> {
  const m = new Map<number, PrivacyRules>();
  fill(await db<RuleRow[]>`select user_id, key, mode, allow, deny from privacy_rules where user_id = ${userId}`, m);
  return m.get(userId) ?? defaultPrivacy();
}

/** Проверить и нормализовать правило: ключ, режим, списки (существующие, без себя и повторов, не длиннее MAX). */
export async function validRule(db: Db, userId: number, key: unknown, body: unknown): Promise<{ key: PrivacyKey; rule: PrivacyRule }> {
  if (typeof key !== 'string' || !PRIVACY_KEYS.includes(key as PrivacyKey)) throw new DomainError('bad_frame');
  const k = key as PrivacyKey;
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new DomainError('bad_frame');
  const mode = b.mode as PrivacyMode;
  if (!MODES.includes(mode) || (k === 'phoneDiscovery' && mode === 'nobody')) throw new DomainError('bad_frame');
  const list = (v: unknown): number[] => {
    if (v === undefined) return [];
    // длина — первой: дальше по массиву не ходим, пока не ясно, что он разумного размера
    if (!Array.isArray(v) || v.length > MAX_EXCEPTIONS) throw new DomainError('bad_frame');
    if (!v.every((x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0)) throw new DomainError('bad_frame');
    return [...new Set(v as number[])].filter((x) => x !== userId);
  };
  // у «Кто найдёт по номеру» исключений нет
  let allow = k === 'phoneDiscovery' ? [] : list(b.allow);
  let deny = k === 'phoneDiscovery' ? [] : list(b.deny);
  // уже записанные в правило исключения остаются, даже если общего чата больше нет: иначе пересохранение
  // (хоть смена режима) молча снимало бы «Никогда не показывать» с того, кто ушёл из общих чатов
  const stored = new Set<number>();
  if (allow.length || deny.length) {
    const cur = (await getRules(db, userId))[k];
    for (const x of [...cur.allow, ...cur.deny]) stored.add(Number(x));
  }
  const all = [...new Set([...allow, ...deny])].filter((x) => !stored.has(x));
  if (all.length) {
    // новые — только те, кого владелец и так видит (контакт или общий чат); остальных молча отбрасываем —
    // ответ не различает «нет такого» и «не знакомы», иначе PUT стал бы способом перебрать id
    const known = new Set([...stored, ...(await db`
      select u.id from users u
       where u.id = any(${all}::bigint[])
         and (exists (select 1 from contacts c where c.owner_id = ${userId} and c.user_id = u.id)
              or exists (select 1 from chat_members a join chats c on c.id = a.chat_id and c.kind <> 'channel' and c.deleted_at is null join chat_members b on b.chat_id = a.chat_id where a.user_id = ${userId} and b.user_id = u.id))`).map((r) => Number(r.id))]);
    allow = allow.filter((x) => known.has(x));
    deny = deny.filter((x) => known.has(x));
  }
  // человек в обоих списках — побеждает «Никогда не показывать» (тот, что в теле позже)
  const denied = new Set(deny);
  allow = allow.filter((x) => !denied.has(x));
  return { key: k, rule: { mode, allow, deny } };
}

/** Записать правило (в транзакции вызывающего). */
export async function writeRule(tx: Tx, userId: number, key: PrivacyKey, r: PrivacyRule): Promise<void> {
  await tx`insert into privacy_rules (user_id, key, mode, allow, deny) values (${userId}, ${key}, ${r.mode}, ${r.allow}::bigint[], ${r.deny}::bigint[])
           on conflict (user_id, key) do update set mode = excluded.mode, allow = excluded.allow, deny = excluded.deny, updated_at = now()`;
}

/** Контекст с подменённым правилом владельца — «как увидят после правки» без второго похода в базу. */
export function withRule(ctx: PrivacyCtx, owner: number, key: PrivacyKey, r: PrivacyRule): PrivacyCtx {
  const rules = new Map(ctx.rules);
  rules.set(owner, { ...(ctx.rules.get(owner) ?? defaultPrivacy()), [key]: r });
  return { ...ctx, rules };
}

/** Контекст с добавленной/снятой блокировкой owner → user. */
export function withBlock(ctx: PrivacyCtx, owner: number, user: number, on: boolean): PrivacyCtx {
  const blocks = new Set(ctx.blocks);
  if (on) blocks.add(pair(owner, user)); else blocks.delete(pair(owner, user));
  return { ...ctx, blocks };
}

/** Заблокировал ли owner зрителя (для PublicUser.blocksMe: плашка вместо поля ввода у заблокированного). */
export function blocksViewer(viewer: number, owner: number, ctx: PrivacyCtx): boolean {
  return viewer !== owner && ctx.blocks.has(pair(owner, viewer));
}

/** Личный чат, собеседник в котором заблокировал userId: писать, править и ставить реакции туда нельзя. */
export async function blockedInDirect(db: Db, chatId: number, userId: number): Promise<boolean> {
  const [r] = await db`
    select 1 from chats c
      join chat_members o on o.chat_id = c.id and o.user_id <> ${userId}
      join blocks b on b.owner_id = o.user_id and b.user_id = ${userId}
     where c.id = ${chatId} and c.kind = 'direct'`;
  return !!r;
}
