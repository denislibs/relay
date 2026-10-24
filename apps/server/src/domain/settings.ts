import { folderError, normalizeFolder, normalizeFolders, FOLDER_LIMITS, SESSION_TTLS, type ChatFolder, type NotifyPref, type NotifyType, type SettingsSnapshot, type UserSettings } from '@relay/protocol';
import { sql, type Tx } from '../db';
import { DomainError } from './errors';
import { appendUpdates } from './journal';
import { getRules, privacyCtx, validRule, withRule, writeRule } from './privacy';
import { reannounce, type Publish } from './presence';
import { republishUser, selfSeq, viewersOf } from './profile';

export const NOTIFY_TYPES: readonly NotifyType[] = ['direct', 'group', 'channel'];
const DEFAULT_TTL = 180;
export const defaultNotify = (): Record<NotifyType, NotifyPref> => ({ direct: { muted: false, preview: true }, group: { muted: false, preview: true }, channel: { muted: false, preview: true } });

type Row = { notify: Partial<Record<NotifyType, Partial<NotifyPref>>> | null; sessions_ttl_days: number; folders?: unknown };

/** Из строки (или её отсутствия) — полные настройки: недостающее добирается умолчаниями. */
function shape(r?: Row): UserSettings {
  const n = defaultNotify();
  for (const t of NOTIFY_TYPES) {
    const v = r?.notify?.[t];
    if (typeof v?.muted === 'boolean') n[t].muted = v.muted;
    if (typeof v?.preview === 'boolean') n[t].preview = v.preview;
  }
  return { notify: n, sessionsTtlDays: r?.sessions_ttl_days ?? DEFAULT_TTL, folders: normalizeFolders(r?.folders) };
}

/** Полный снимок настроек (с правилами приватности) в транзакции: любой ответ — состояние «на seq» целиком. */
async function snapshot(tx: Tx, userId: number): Promise<SettingsSnapshot> {
  const [r] = await tx<Row[]>`select notify, sessions_ttl_days, folders from user_settings where user_id = ${userId}`;
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
    const [cur] = await tx<Row[]>`select notify, sessions_ttl_days, folders from user_settings where user_id = ${userId} for update`;
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

/** Срок автозавершения неактивных сеансов (7 | 30 | 90 | 180 | 365 дней) + settingsChanged себе. Сеансы старше нового срока завершает вызывающий (sweepInactive). */
export async function setSessionsTtl(userId: number, body: unknown): Promise<SettingsSnapshot> {
  const days = (body as { days?: unknown } | null)?.days;
  if (typeof days !== 'number' || !SESSION_TTLS.includes(days)) throw new DomainError('bad_frame');
  return sql.begin(async (tx) => {
    await tx`insert into user_settings (user_id) values (${userId}) on conflict (user_id) do nothing`;
    const [cur] = await tx<Row[]>`select notify, sessions_ttl_days, folders from user_settings where user_id = ${userId} for update`;
    const settings = shape(cur);
    if (settings.sessionsTtlDays !== days) {
      settings.sessionsTtlDays = days;
      await tx`update user_settings set sessions_ttl_days = ${days}, updated_at = now() where user_id = ${userId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'settingsChanged', settings } }]);
    }
    return snapshot(tx, userId);
  }) as Promise<SettingsSnapshot>;
}

/**
 * Правка списка папок одной транзакцией: строка под замком, новое значение из прежнего, settingsChanged себе
 * только если правда изменилось. Ответ — снимок (база для оптимистичного вида движка).
 */
async function editFolders(userId: number, fn: (folders: ChatFolder[]) => ChatFolder[]): Promise<SettingsSnapshot> {
  return sql.begin(async (tx) => {
    await tx`insert into user_settings (user_id) values (${userId}) on conflict (user_id) do nothing`;
    const [cur] = await tx<Row[]>`select notify, sessions_ttl_days, folders from user_settings where user_id = ${userId} for update`;
    const settings = shape(cur);
    const next = fn(settings.folders);
    if (JSON.stringify(next) !== JSON.stringify(settings.folders)) {
      settings.folders = next;
      await tx`update user_settings set folders = ${tx.json(next as never)}, updated_at = now() where user_id = ${userId}`;
      await appendUpdates(tx, [{ userId, update: { type: 'settingsChanged', settings } }]);
    }
    return snapshot(tx, userId);
  }) as Promise<SettingsSnapshot>;
}

/** Создать или изменить папку (PUT /settings/folders/:id). Новая встаёт в конец; больше лимита — folders_limit. */
export async function saveFolder(userId: number, id: number, body: unknown): Promise<SettingsSnapshot> {
  const f = normalizeFolder({ ...(body && typeof body === 'object' ? body : {}), id });
  if (!f) throw new DomainError('bad_frame');
  const err = folderError(f);
  if (err) throw new DomainError(err);
  return editFolders(userId, (folders) => {
    const i = folders.findIndex((x) => x.id === id);
    if (i >= 0) return folders.map((x, k) => (k === i ? f : x));
    if (folders.length >= FOLDER_LIMITS.folders) throw new DomainError('folders_limit');
    return [...folders, f];
  });
}

/** Удалить папку (DELETE /settings/folders/:id). Нет такой — ничего не меняется (повтор удаления не ошибка). */
export function deleteFolder(userId: number, id: number): Promise<SettingsSnapshot> {
  return editFolders(userId, (folders) => folders.filter((x) => x.id !== id));
}

/**
 * Порядок папок (PUT /settings/folders/order { ids }). Неизвестные id отбрасываются, забытые встают в конец
 * в прежнем порядке — порядок с устройства, не знавшего о новой папке, её не теряет.
 */
export function reorderFolders(userId: number, body: unknown): Promise<SettingsSnapshot> {
  const raw = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(raw)) throw new DomainError('bad_frame');
  return editFolders(userId, (folders) => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const out: ChatFolder[] = [];
    for (const x of raw) { const f = typeof x === 'number' ? byId.get(x) : undefined; if (f) { out.push(f); byId.delete(x as number); } }
    return [...out, ...folders.filter((f) => byId.has(f.id))];
  });
}
