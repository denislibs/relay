// Чистые правила локальных уведомлений и звука — без DOM, чтобы проверять юнит-тестами.
import type { NotifyState } from './notify';
import type { Prefs } from './prefs';

export interface NotifyPref { muted: boolean; preview: boolean }
/** Тело уведомления без предпросмотра (так же, как у серверного push). */
export const NO_PREVIEW = 'Новое сообщение';

export interface IncomingInput {
  state: NotifyState;               // разрешение и включённость на этом устройстве
  device: Prefs['notify'];          // настройки устройства: web, звук, громкость
  chatMuted: boolean;               // чат выключен на этом устройстве (relay.muted)
  pref: NotifyPref;                 // умолчания аккаунта для вида чата
  hasFocus: boolean;
}
export interface IncomingPlan { show: boolean; preview: boolean; volume: number }

/** Показывать ли уведомление о входящем, с текстом ли и с какой громкостью (0 — без звука). */
export function planIncoming(i: IncomingInput): IncomingPlan {
  const show = i.state === 'on' && i.device.web && !i.chatMuted && !i.pref.muted && !i.hasFocus;
  return { show, preview: i.pref.preview, volume: show && i.device.sound ? i.device.volume : 0 };
}

/** Звук включён только при ненулевой громкости. */
export const soundOn = (n: Pick<Prefs['notify'], 'sound' | 'volume'>): boolean => n.sound && n.volume > 0;

/** Переключатель «Звук»: включение при нулевой громкости ставит 50 %. */
export function toggleSound(n: Pick<Prefs['notify'], 'sound' | 'volume'>, on: boolean): { sound: boolean; volume: number } {
  return on ? { sound: true, volume: n.volume > 0 ? n.volume : 0.5 } : { sound: false, volume: n.volume };
}

/** Ползунок (0–100 %): нуль выключает звук, любое другое значение включает. */
export function volumeFromSlider(pct: number): { sound: boolean; volume: number } {
  const volume = Math.min(1, Math.max(0, Math.round(pct) / 100));
  return { sound: volume > 0, volume };
}
export const volumePct = (v: number): number => Math.round(v * 100);
