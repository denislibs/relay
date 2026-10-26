import { findChat, getGlobal, subscribeGlobal } from './global';
import { getPrefs } from './prefs';

declare const __DEV__: boolean;

type ScreenPrefs = { hideChatInTitle: boolean; hideUnreadInTitle: boolean };

/** «(3) Анна — Relay» / «Relay»; флаги приватности экрана прячут имя чата и счётчик. */
export function titleFor(i: { chatTitle: string | null; unread: number; prefs: ScreenPrefs }): string {
  const count = i.unread > 0 && !i.prefs.hideUnreadInTitle ? `(${capped(i.unread)}) ` : '';
  const chat = i.chatTitle && !i.prefs.hideChatInTitle ? `${i.chatTitle} — Relay` : 'Relay';
  return count + chat;
}

/** Число для значка: больше 99 — «99+». */
export const capped = (n: number): string => (n > 99 ? '99+' : String(n));

/** Сколько показывать на значке (0 — убрать). */
export const badgeCount = (unread: number, prefs: ScreenPrefs): number => (prefs.hideUnreadInTitle ? 0 : Math.max(0, unread));

/** «1 новое сообщение», «3 новых сообщения», «5 новых сообщений». */
export function blinkText(n: number): string {
  if (n > 99) return '99+ новых сообщений';
  const m10 = n % 10, m100 = n % 100;
  const form = m10 === 1 && m100 !== 11 ? 'новое сообщение' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'новых сообщения' : 'новых сообщений';
  return `${capped(n)} ${form}`;
}

/**
 * Новые с момента ухода: сколько сообщений пришло, пока окно было неактивно, по чатам. Прочитали где угодно
 * (другая вкладка, другое устройство) — у чата падает unread, и счёт не может быть больше него.
 */
export function clampPending(pending: Map<number, number>, unreadOf: (chatId: number) => number | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, n] of pending) {
    const u = unreadOf(id);
    const left = Math.min(n, u ?? n);
    if (left > 0) out.set(id, left);
  }
  return out;
}

let lastIn: { counters: unknown; open: unknown; chats: unknown; prefs: unknown } = { counters: null, open: null, chats: null, prefs: null };
let lastTitle = '';
let lastBadge = -1;
let base = { title: 'Relay', badge: -1 };   // обычный вид, без мигания (-1 — ещё не считали)

// Мигание вкладки — как в Telegram Web: пока окно неактивно и пришли новые сообщения (не из заглушённых чатов),
// раз в секунду заголовок сменяется на «N новых сообщений», а значок — на чистый знак. Стало активным окно любой
// вкладки — счёт обнуляется во всех (BroadcastChannel); прочитали где угодно — уменьшается по unread чатов.
let pending = new Map<number, number>();
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkOn = false;
let channel: BroadcastChannel | null = null;
const pendingTotal = () => { let t = 0; for (const n of pending.values()) t += n; return t; };
const windowActive = () => document.visibilityState === 'visible' && document.hasFocus();
let baseIcon: string | null = null;
let iconSeq = 0;

function drawFavicon(n: number): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (baseIcon === null) baseIcon = link.href;
  if (n <= 0) { iconSeq++; link.href = baseIcon; return; }
  const seq = ++iconSeq;
  const img = new Image();
  img.onerror = () => { if (seq === iconSeq) link.href = baseIcon!; };
  img.onload = () => {
    if (seq !== iconSeq) return;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, 32, 32);
    const text = capped(n);
    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    if (text.length === 1) ctx.arc(22, 10, 10, 0, Math.PI * 2);
    else ctx.roundRect(8, 0, 24, 20, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, text.length === 1 ? 22 : 20, 11);
    link.href = c.toDataURL('image/png');
  };
  img.src = baseIcon;
}

function paint(): void {
  const title = blinkOn ? blinkText(pendingTotal()) : base.title;
  if (title !== lastTitle) { lastTitle = title; document.title = title; }
  const icon = blinkOn ? 0 : base.badge;
  if (icon !== lastBadge) { lastBadge = icon; drawFavicon(icon); }
}

function syncBlink(): void {
  const want = pending.size > 0 && !windowActive() && !getPrefs().screen.hideUnreadInTitle;
  if (want && !blinkTimer) {
    blinkOn = true;
    blinkTimer = setInterval(() => { blinkOn = !blinkOn; paint(); }, 1000);
  } else if (!want && blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkOn = false;
  }
  paint();
}

function clearPending(broadcast: boolean): void {
  if (broadcast) try { channel?.postMessage('active'); } catch { /* ok */ }
  if (!pending.size) return;
  pending = new Map();
  syncBlink();
}

/** Чужое сообщение пришло (по одному на сообщение, как уведомление): в счёт мигания, если окно неактивно. */
export function noteIncoming(chatId: number, o: { muted: boolean; createdAt: string }): void {
  if (o.muted || windowActive()) return;
  if (Date.now() - Date.parse(o.createdAt) > 2 * 60_000) return;   // догоняющая синхронизация после офлайна — не новость
  pending.set(chatId, (pending.get(chatId) ?? 0) + 1);
  syncBlink();
}

/** Применить заголовок, значок и бейдж приложения; меняет только то, что изменилось. */
export function updateTitle(): void {
  const g = getGlobal();
  const prefs = getPrefs().screen;
  if (g.counters === lastIn.counters && g.openChatId === lastIn.open && g.chats === lastIn.chats && prefs === lastIn.prefs) return;
  lastIn = { counters: g.counters, open: g.openChatId, chats: g.chats, prefs };
  const unread = g.counters.unreadMessages;
  const t = g.openChatId ? findChat(g, g.openChatId)?.title : null;
  const chatTitle = typeof t === 'string' ? t : null;
  const badge = badgeCount(unread, prefs);
  const appBadgeChanged = badge !== base.badge;
  base = { title: titleFor({ chatTitle, unread, prefs }), badge };
  if (pending.size) {
    const byId = new Map(g.chats.map((c) => [c.id as number, Number(c.unread) || 0]));
    pending = clampPending(pending, (id) => byId.get(id));
  }
  syncBlink();
  if (appBadgeChanged) {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (badge > 0 ? nav.setAppBadge?.(badge) : nav.clearAppBadge?.())?.catch((e) => { if (__DEV__) console.warn('badge:', String(e)); }); } catch (e) { if (__DEV__) console.warn('badge:', String(e)); }
  }
}

export function startTitle(): void {
  subscribeGlobal(updateTitle);
  try { channel = new BroadcastChannel('relay-title'); channel.onmessage = () => clearPending(false); } catch { channel = null; }
  const onActive = () => { if (windowActive()) clearPending(true); else syncBlink(); };
  addEventListener('focus', onActive);
  addEventListener('blur', onActive);
  document.addEventListener('visibilitychange', onActive);
  updateTitle();
}
