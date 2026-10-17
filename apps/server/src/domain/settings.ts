import type { NotifyPref, NotifyType, SettingsSnapshot, UserSettings } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { getRules, privacyCtx, validRule, withRule, writeRule } from './privacy';
import { reannounce, type Publish } from './presence';
import { republishUser, selfSeq, viewersOf } from './profile';

export const NOTIFY_TYPES: readonly NotifyType[] = ['direct', 'group'];
const DEFAULT_TTL = 180;
export const defaultNotify = (): Record<NotifyType, NotifyPref> => ({ direct: { muted: false, preview: true }, group: { muted: false, preview: true } });

type Row = { notify: Partial<Record<NotifyType, Partial<NotifyPref>>> | null; sessions_ttl_days: number };

/** Из строки (или её отсутствия) — полные настройки: недостающее добирается умолчаниями. */
function shape(r?: Row): UserSettings {
  const n = defaultNotify();
  for (const t of NOTIFY_TYPES) {
    const v = r?.notify?.[t];
    if (typeof v?.muted === 'boolean') n[t].muted = v.muted;
    if (typeof v?.preview === 'boolean') n[t].preview = v.preview;
  }
  return { notify: n, sessionsTtlDays: r?.sessions_ttl_days ?? DEFAULT_TTL };
}

/** Полный снимок настроек (с правилами приватности) в транзакции: любой ответ — состояние «на seq» целиком. */
async function snapshot(tx: Tx, userId: number): Promise<SettingsSnapshot> {
  const [r] = await tx<Row[]>`select notify, sessions_ttl_days from user_settings where user_id = ${userId}`;
  return { ...shape(r), privacy: await getRules(tx, userId), seq: await selfSeq(tx, userId) };
}

/** Настройки пользователя; строки нет — умолчания. seq — своей записи журнала в том же снимке. */
export async function getSettings(userId: number): Promise<SettingsSnapshot> {
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    return snapshot(tx, userId);
  }) as Promise<SettingsSnapshot>;
}

/**
 * Правило конфиденциальности (PUT /privacy/:key). Одной транзакцией: правило, privacyChanged себе
 * и корректирующий userUpdated тем зрителям, у кого из-за правила пропало или появилось поле профиля.
 * Присутствие (lastSeen) — не журнал: переобъявляется после коммита (presence.reannounce), если передан publish.
 */
export async function setPrivacy(userId: number, key: unknown, body: unknown, publish?: Publish): Promise<SettingsSnapshot> {
  const { key: k, rule } = await validRule(sql, userId, key, body);
  let changed = false;
  const res = await sql.begin(async (tx) => {
    await tx`select 1 from users where id = ${userId} for no key update`;   // правки одного человека — по очереди
    const before = await getRules(tx, userId);
    if (JSON.stringify(before[k]) !== JSON.stringify(rule)) {
      await writeRule(tx, userId, k, rule);
      changed = true;
      await appendUpdates(tx, [{ userId, update: { type: 'privacyChanged', rules: { ...before, [k]: rule } } }]);
      if (k === 'phone' || k === 'bio' || k === 'birthday') {
        const viewers = await viewersOf(tx, userId);
        const ctx = await privacyCtx(tx, viewers.map((v) => [v, userId]));
        // ctx снят после записи правила — «до» восстанавливаем подменой
        await republishUser(tx, userId, viewers, withRule(ctx, userId, k, before[k]), ctx);
      }
    }
    return snapshot(tx, userId);
  }) as SettingsSnapshot;
  // присутствие — не журнал: собеседникам (и себе — взаимность) после коммита, только если правило правда сменилось
  if (publish && changed && k === 'lastSeen') await reannounce(publish, userId).catch((e) => console.error('presence:', e));
  return res;
}

/** Умолчания для получателя — для push (одним запросом по нескольким). */
export async function notifyDefaults(db: Tx | typeof sql, userIds: number[]): Promise<Map<number, Record<NotifyType, NotifyPref>>> {
  const out = new Map<number, Record<NotifyType, NotifyPref>>();
  if (!userIds.length) return out;
  const rows = await db<(Row & { user_id: number })[]>`select user_id, notify, sessions_ttl_days from user_settings where user_id = any(${userIds})`;
  for (const r of rows) out.set(Number(r.user_id), shape(r).notify);
  return out;
}

/** Выключить/включить уведомления и предпросмотр для вида чата. Записать и settingsChanged себе — одной транзакцией. */
export async function setNotify(userId: number, type: unknown, patch: unknown): Promise<SettingsSnapshot> {
  if (typeof type !== 'string' || !NOTIFY_TYPES.includes(type as NotifyType)) throw new DomainError('bad_frame');
  const p = patch as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new DomainError('bad_frame');
  const muted = p.muted, preview = p.preview;
  if ((muted !== undefined && typeof muted !== 'boolean') || (preview !== undefined && typeof preview !== 'boolean')) throw new DomainError('bad_frame');
  const t = type as NotifyType;
  return sql.begin(async (tx) => {
    await tx`insert into user_settings (user_id) values (${userId}) on conflict (user_id) do nothing`;
    const [cur] = await tx<Row[]>`select notify, sessions_ttl_days from user_settings where user_id = ${userId} for update`;
    const settings = shape(cur);
    const before = JSON.stringify(settings);
    if (muted !== undefined) settings.notify[t].muted = muted;
    if (preview !== undefined) settings.notify[t].preview = preview;
    if (JSON.stringify(settings) !== before) {
      await tx`update user_settings set notify = ${tx.json(settings.notify as never)}, updated_at = now() where user_id = ${userId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'settingsChanged', settings } }]);
    }
    return snapshot(tx, userId);
  }) as Promise<SettingsSnapshot>;
}
