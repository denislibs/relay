// Клик по большому эмодзи (как в Telegram, только личный чат): анимация заново, полноэкранный эффект рядом и
// пачка кликов собеседнику — он увидит то же с теми же паузами. Пачка: окно от первого клика (EMOJI_FX_BATCH_MS),
// t — секунды от первого клика. Чужая пачка приходит отметкой fx на сообщении — лента проигрывает её, если чат
// открыт и сообщение на экране.
import { EMOJI_FX_MAX, EMOJI_FX_WINDOW_S } from '@relay/protocol';
import { playEmojiInteraction, reducedMotion } from '@relay/ui';
import { emojiEffects, genericEmojiEffects } from './animatedEmoji';
import { emojiFx } from './data';
import { getPrefs } from './prefs';

export const EMOJI_FX_BATCH_MS = 1000;

export const emojiFxEnabled = (): boolean => getPrefs().anim.level > 0 && !reducedMotion();

/** Пачка кликов на одно сообщение: клики копятся окно от первого, потом уходят одним кадром. */
export function createBatcher(send: (chatId: number, id: number, key: string, t: number[]) => void, now: () => number = () => Date.now(), later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }) {
  const open = new Map<string, { chatId: number; id: number; key: string; first: number; t: number[] }>();
  return {
    click(chatId: number, id: number, key: string): void {
      const k = chatId + ':' + id;
      let b = open.get(k);
      if (!b) {
        b = { chatId, id, key, first: now(), t: [] };
        open.set(k, b);
        later(() => { open.delete(k); if (b!.t.length) send(b!.chatId, b!.id, b!.key, b!.t); }, EMOJI_FX_BATCH_MS);
      }
      if (b.t.length < EMOJI_FX_MAX) b.t.push(Math.min(EMOJI_FX_WINDOW_S, Math.round((now() - b.first) / 10) / 100));
    },
    pending: () => open.size,
  };
}
const batcher = createBatcher(emojiFx);

/** Эффект у стикера эмодзи: свой вариант или общий 💥 (зеркальный); у входящих — отражение, как в tweb. */
export function playEmojiEffect(el: HTMLElement, key: string, out: boolean): boolean {
  if (!emojiFxEnabled()) return false;
  const own = emojiEffects(key);
  const generic = !own.length;
  const list = own.length ? own : genericEmojiEffects();
  if (!list.length) return false;
  const url = list[Math.floor(Math.random() * list.length)];
  return playEmojiInteraction(el, { url, side: out ? 'right' : 'left', mirror: !out !== generic });
}

/**
 * Клик по своему или чужому большому эмодзи: эффект сразу; настоящий клик (trusted) идёт собеседнику пачкой,
 * синтетический (проигрывание его пачки) — нет.
 */
export function clickBigEmoji(chatId: number, id: number, key: string, el: HTMLElement, out: boolean, trusted: boolean): void {
  if (!playEmojiEffect(el, key, out)) return;   // эффекты выключены — собеседнику тоже ничего
  if (trusted && id > 0) batcher.click(chatId, id, key);
}

const played = new Set<number>();   // at пачек, которые уже проиграли (строка перерисовывается чаще, чем приходят пачки)
export const FX_STALE_MS = 10_000;

/** Чужая пачка на сообщении: эффекты с теми же паузами — синтетический клик по стикеру (анимация заново + эффект). */
export function scheduleIncomingFx(msgKey: string, fx: { key: string; t: number[]; at: number }, out: boolean): void {
  if (played.has(fx.at) || Date.now() - fx.at > FX_STALE_MS || !emojiFxEnabled()) return;
  played.add(fx.at);
  if (played.size > 200) played.clear();
  for (const t of fx.t.slice(0, EMOJI_FX_MAX)) {
    setTimeout(() => {
      const col = document.querySelector('.app-chatcol[data-current]') ?? document;
      const one = col.querySelector<HTMLElement>(`.app-msg[data-key="${CSS.escape(msgKey)}"] .rl-emoji-one`);
      if (!one) return;
      const r = one.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;   // не на экране — молча
      const sticker = one.querySelector<HTMLElement>('.rl-sticker');
      if (sticker) sticker.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // не trusted — обратно не уйдёт
      else playEmojiEffect(one, fx.key, out);   // эмодзи без анимации в наборе — только эффект
    }, Math.max(0, t * 1000));
  }
}
