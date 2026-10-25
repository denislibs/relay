// Эффект при реакции (center + around над плашкой): кто и когда его запускает.
// Своя реакция — сразу после оптимистичного обновления, когда плашка появилась в DOM (строка ленты забирает
// заявку из очереди при перерисовке); чужая на моё сообщение — при прочтении, с задержкой как в Telegram.
import { playReactionEffect, reducedMotion } from '@relay/ui';
import { getPrefs } from './prefs';
import { reactionByKey } from './reactions';

export const FX_READ_DELAY_MS = 150;

const pending = new Map<string, string>();   // ключ сообщения → ключ реакции

export const fxEnabled = (): boolean => getPrefs().anim.level > 0 && !reducedMotion();

/** Заявка на эффект: строка ленты заберёт её при следующей перерисовке. */
export function queueReactionFx(msgKey: string, key: string): void { pending.set(msgKey, key); }   // включены ли эффекты — решает playFxForMessage
export function takeReactionFx(msgKey: string): string | undefined { const k = pending.get(msgKey); if (k) pending.delete(msgKey); return k; }

/** Запустить эффект над плашкой реакции key в строке сообщения msgKey (если она на экране и у реакции есть анимации). */
export function playFxForMessage(msgKey: string, key: string): boolean {
  if (!fxEnabled()) return false;
  const asset = reactionByKey(key);
  if (!asset?.center || !asset.around) return false;
  // в стеке чатов закрытые колонки остаются в DOM (сдвинуты за край) — ищем только в текущей
  const col = document.querySelector('.app-chatcol[data-current]') ?? document;
  const icon = col.querySelector<HTMLElement>(`.app-msg[data-key="${CSS.escape(msgKey)}"] .rl-react[data-key="${CSS.escape(key)}"] .rl-react-icon`);
  return !!icon && playReactionEffect(icon, { center: asset.center, around: asset.around });
}
