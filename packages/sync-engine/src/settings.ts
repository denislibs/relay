import { defaultPrivacy, PRIVACY_KEYS, type NotifyPref, type NotifyType, type PrivacyKey, type PrivacyRule, type PrivacyRules, type UserSettings } from '@relay/protocol';
import type { PendingOp } from './ops';
import { OP_SESSIONS_TTL } from './sessions';
import type { Item } from './types';

/** Настройки аккаунта в движке: умолчания уведомлений + правила конфиденциальности. */
export type AccountSettings = UserSettings & { privacy: PrivacyRules };

/** Ключ операции умолчаний уведомлений в очереди ops: по одному на вид чата (правки одного вида схлопываются). */
export const OP_NOTIFY = 'notify:';
export const notifyKey = (t: NotifyType) => OP_NOTIFY + t;
const notifyTypeOf = (key: string): NotifyType | null => (key === OP_NOTIFY + 'direct' ? 'direct' : key === OP_NOTIFY + 'group' ? 'group' : null);

/** Ключ операции правила конфиденциальности: по одному на правило (правки одного правила схлопываются). */
export const OP_PRIVACY = 'privacy:';
export const privacyKey = (k: PrivacyKey) => OP_PRIVACY + k;
const privacyKeyOf = (key: string): PrivacyKey | null => {
  if (!key.startsWith(OP_PRIVACY)) return null;
  const k = key.slice(OP_PRIVACY.length) as PrivacyKey;
  return PRIVACY_KEYS.includes(k) ? k : null;
};

export const defaultSettings = (): AccountSettings => ({
  notify: { direct: { muted: false, preview: true }, group: { muted: false, preview: true } },
  sessionsTtlDays: 180,
  privacy: defaultPrivacy(),
});

const MODES = ['everyone', 'contacts', 'nobody'];
const idList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x)) : []);
/** Правило из возможно неполного (старый IDB, тело операции): недостающее — по умолчанию. */
export function normalizeRule(k: PrivacyKey, r: unknown): PrivacyRule {
  const d = defaultPrivacy()[k];
  const v = r as Partial<PrivacyRule> | null | undefined;
  if (!v || typeof v !== 'object') return d;
  return { mode: MODES.includes(v.mode as string) ? v.mode! : d.mode, allow: idList(v.allow), deny: idList(v.deny) };
}
export function normalizePrivacy(p: unknown): PrivacyRules {
  const out = defaultPrivacy();
  const v = p as Partial<Record<PrivacyKey, unknown>> | null | undefined;
  if (v && typeof v === 'object') for (const k of PRIVACY_KEYS) if (v[k] !== undefined) out[k] = normalizeRule(k, v[k]);
  return out;
}

/**
 * Настройки аккаунта: база — последнее, что сказал сервер (GET /settings, ответ операции, settingsChanged).
 * Источники приходят вразнобой — упорядочивает seq журнала владельца: старое не откатывает новое.
 * Хранится в IDB в meta.settings и пишется вместе с lastSeq в Store.flush.
 */
/** Полные настройки из возможно неполных (старый IDB, ответ другой версии): по каждому виду чата — слияние с умолчаниями. */
export function normalizeSettings(s: Partial<AccountSettings> | null | undefined): AccountSettings {
  const d = defaultSettings();
  for (const t of ['direct', 'group'] as const) {
    const v = s?.notify?.[t];
    if (typeof v?.muted === 'boolean') d.notify[t].muted = v.muted;
    if (typeof v?.preview === 'boolean') d.notify[t].preview = v.preview;
  }
  if (typeof s?.sessionsTtlDays === 'number') d.sessionsTtlDays = s.sessionsTtlDays;
  d.privacy = normalizePrivacy(s?.privacy);
  return d;
}

export class SettingsCache {
  base: AccountSettings = defaultSettings();
  /** снимок с сервера уже был (иначе показываем умолчания как «ещё не знаем») */
  loaded = false;
  seq = 0;
  /** изменилось с последнего прохода подписок */
  dirty = false;
  private persist = false;

  static load(meta: { k: string; v: unknown }[]): SettingsCache {
    const c = new SettingsCache();
    const v = meta.find((m) => m.k === 'settings')?.v as { base: AccountSettings; seq: number } | undefined;
    if (v) { c.base = normalizeSettings(v.base); c.seq = v.seq; c.loaded = true; }
    return c;
  }

  /**
   * Новая база. seq — номер записи журнала (или ответа); старее известного — игнорируем.
   * Без privacy (settingsChanged — только уведомления) правила остаются прежними: журнал применяется по порядку,
   * а ответы сервера (GET /settings, операции) всегда несут снимок целиком.
   */
  apply(s: UserSettings & { privacy?: PrivacyRules }, seq?: number): boolean {
    if (seq !== undefined && seq < this.seq) return false;
    const next = normalizeSettings({ ...s, privacy: s.privacy ?? this.base.privacy });
    // то же самое (эхо журнала, повторный снимок): seq запоминаем, подписки не трогаем
    if (this.loaded && JSON.stringify(next) === JSON.stringify(this.base)) {
      if (seq !== undefined && seq > this.seq) { this.seq = seq; this.persist = true; }
      return false;
    }
    if (seq !== undefined) this.seq = seq;
    this.base = next;
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

  /** privacyChanged из журнала: правила целиком. */
  applyPrivacy(rules: PrivacyRules, seq?: number): boolean {
    return this.apply({ notify: this.base.notify, sessionsTtlDays: this.base.sessionsTtlDays, privacy: rules }, seq);
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
export function settingsView<S extends UserSettings & { privacy?: PrivacyRules }>(base: S, ops: readonly PendingOp[]): S {
  let notify = base.notify;
  let privacy = base.privacy;
  let ttl = base.sessionsTtlDays;
  for (const op of ops) {
    if (op.key === OP_SESSIONS_TTL) { const d = (op.body as { days?: unknown } | undefined)?.days; if (typeof d === 'number') ttl = d; continue; }
    const pk = privacyKeyOf(op.key);
    if (pk && privacy) { privacy = { ...privacy, [pk]: normalizeRule(pk, op.body) }; continue; }
    const t = notifyTypeOf(op.key);
    if (!t) continue;
    const b = (op.body ?? {}) as Partial<NotifyPref>;
    const cur = notify[t];
    notify = { ...notify, [t]: { muted: typeof b.muted === 'boolean' ? b.muted : cur.muted, preview: typeof b.preview === 'boolean' ? b.preview : cur.preview } };
  }
  return notify === base.notify && privacy === base.privacy && ttl === base.sessionsTtlDays ? base : { ...base, notify, privacy, sessionsTtlDays: ttl };
}

/** Элемент подписки settings. */
export function settingsItem(view: AccountSettings, loaded: boolean, pending: boolean): Item[] {
  return [{ key: 'settings', notify: view.notify, sessionsTtlDays: view.sessionsTtlDays, privacy: view.privacy, loaded, pending }];
}

/** Ответ операции — новая база, если это наши настройки (уведомления или правило конфиденциальности). */
export function isNotifyOp(op: PendingOp): boolean { return notifyTypeOf(op.key) !== null || privacyKeyOf(op.key) !== null || op.key === OP_SESSIONS_TTL; }
