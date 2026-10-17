import { getGlobal, subscribeGlobal } from './global';
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

let lastIn: { counters: unknown; open: unknown; chats: unknown; prefs: unknown } = { counters: null, open: null, chats: null, prefs: null };
let lastTitle = '';
let lastBadge = -1;
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

/** Применить заголовок, значок и бейдж приложения; меняет только то, что изменилось. */
export function updateTitle(): void {
  const g = getGlobal();
  const prefs = getPrefs().screen;
  if (g.counters === lastIn.counters && g.openChatId === lastIn.open && g.chats === lastIn.chats && prefs === lastIn.prefs) return;
  lastIn = { counters: g.counters, open: g.openChatId, chats: g.chats, prefs };
  const unread = g.counters.unreadMessages;
  const chatTitle = g.openChatId ? g.chats.find((c) => c.id === g.openChatId)?.title ?? null : null;
  const title = titleFor({ chatTitle, unread, prefs });
  if (title !== lastTitle) { lastTitle = title; document.title = title; }
  const badge = badgeCount(unread, prefs);
  if (badge !== lastBadge) {
    lastBadge = badge;
    drawFavicon(badge);
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try { void (badge > 0 ? nav.setAppBadge?.(badge) : nav.clearAppBadge?.())?.catch((e) => { if (__DEV__) console.warn('badge:', String(e)); }); } catch (e) { if (__DEV__) console.warn('badge:', String(e)); }
  }
}

export function startTitle(): void {
  subscribeGlobal(updateTitle);
  updateTitle();
}
