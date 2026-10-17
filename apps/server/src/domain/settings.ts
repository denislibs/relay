import type { NotifyPref, NotifyType, SettingsSnapshot, UserSettings } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { selfSeq } from './profile';

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

/** Настройки пользователя; строки нет — умолчания. seq — своей записи журнала в том же снимке. */
export async function getSettings(userId: number): Promise<SettingsSnapshot> {
  return sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read`;
    const [r] = await tx<Row[]>`select notify, sessions_ttl_days from user_settings where user_id = ${userId}`;
    return { ...shape(r), seq: await selfSeq(tx, userId) };
  }) as Promise<SettingsSnapshot>;
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
    return { ...settings, seq: await selfSeq(tx, userId) };
  }) as Promise<SettingsSnapshot>;
}
