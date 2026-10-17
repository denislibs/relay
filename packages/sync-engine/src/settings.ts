import type { NotifyPref, NotifyType, UserSettings } from '@relay/protocol';
import type { PendingOp } from './ops';
import type { Item } from './types';

/** Ключ операции умолчаний уведомлений в очереди ops: по одному на вид чата (правки одного вида схлопываются). */
export const OP_NOTIFY = 'notify:';
export const notifyKey = (t: NotifyType) => OP_NOTIFY + t;
const notifyTypeOf = (key: string): NotifyType | null => (key === OP_NOTIFY + 'direct' ? 'direct' : key === OP_NOTIFY + 'group' ? 'group' : null);

export const defaultSettings = (): UserSettings => ({
  notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } },
  sessionsTtlDays: 180,
});

/**
 * Настройки аккаунта: база — последнее, что сказал сервер (GET /settings, ответ операции, settingsChanged).
 * Источники приходят вразнобой — упорядочивает seq журнала владельца: старое не откатывает новое.
 * Хранится в IDB в meta.settings и пишется вместе с lastSeq в Store.flush.
 */
/** Полные настройки из возможно неполных (старый IDB, ответ другой версии): по каждому виду чата — слияние с умолчаниями. */
export function normalizeSettings(s: Partial<UserSettings> | null | undefined): UserSettings {
  const d = defaultSettings();
  for (const t of ['direct', 'group'] as const) {
    const v = s?.notify?.[t];
    if (typeof v?.muted === 'boolean') d.notify[t].muted = v.muted;
    if (typeof v?.preview === 'boolean') d.notify[t].preview = v.preview;
  }
  if (typeof s?.sessionsTtlDays === 'number') d.sessionsTtlDays = s.sessionsTtlDays;
  return d;
}

export class SettingsCache {
  base: UserSettings = defaultSettings();
  /** снимок с сервера уже был (иначе показываем умолчания как «ещё не знаем») */
  loaded = false;
  seq = 0;
  /** изменилось с последнего прохода подписок */
  dirty = false;
  private persist = false;

  static load(meta: { k: string; v: unknown }[]): SettingsCache {
    const c = new SettingsCache();
    const v = meta.find((m) => m.k === 'settings')?.v as { base: UserSettings; seq: number } | undefined;
    if (v) { c.base = normalizeSettings(v.base); c.seq = v.seq; c.loaded = true; }
    return c;
  }

  /** Новая база. seq — номер записи журнала (или ответа); старее известного — игнорируем. */
  apply(s: UserSettings, seq?: number): boolean {
    if (seq !== undefined && seq < this.seq) return false;
    if (seq !== undefined) this.seq = seq;
    this.base = normalizeSettings(s);
    this.loaded = true;
    this.dirty = true;
    this.persist = true;
    return true;
  }

  collect(): { k: string; v: unknown } | null {
    if (!this.persist) return null;
    this.persist = false;
    return { k: 'settings', v: { base: this.base, seq: this.seq } };
  }

  /** База сервера пересоздана: всё забыть. */
  reset(): void {
    this.base = defaultSettings();
    this.seq = 0;
    this.loaded = false;
    this.dirty = true;
    this.persist = false;
  }
}

/** Настройки, как их видит интерфейс: база + ещё не подтверждённые операции из очереди (по порядку). */
export function settingsView(base: UserSettings, ops: readonly PendingOp[]): UserSettings {
  let notify = base.notify;
  for (const op of ops) {
    const t = notifyTypeOf(op.key);
    if (!t) continue;
    const b = (op.body ?? {}) as Partial<NotifyPref>;
    const cur = notify[t];
    notify = { ...notify, [t]: { muted: typeof b.muted === 'boolean' ? b.muted : cur.muted, preview: typeof b.preview === 'boolean' ? b.preview : cur.preview } };
  }
  return notify === base.notify ? base : { ...base, notify };
}

/** Элемент подписки settings. */
export function settingsItem(view: UserSettings, loaded: boolean, pending: boolean): Item[] {
  return [{ key: 'settings', notify: view.notify, sessionsTtlDays: view.sessionsTtlDays, loaded, pending }];
}

/** Ответ операции — новая база, если это наши настройки. */
export function isNotifyOp(op: PendingOp): boolean { return notifyTypeOf(op.key) !== null; }
