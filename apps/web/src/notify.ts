import { getGlobal, setGlobal } from './global';
import { notifyText, planIncoming } from './notifyRules';
import { getPrefs, setPref, subscribePrefs } from './prefs';
import { playNotifySound } from './sound';

/**
 * Уведомления о новых сообщениях — два пути, оба через Service Worker и с одним tag на чат
 * (повтор заменяет прежнее, а не копится):
 *  • вкладка открыта, но окно не в фокусе — показывает сама, по патчу списка чатов;
 *  • вкладок нет — сервер шлёт Web Push (только тем, у кого нет живого соединения).
 * Выключенные чаты (relay.muted) уходят на сервер вместе с подпиской: они «на этом устройстве».
 */
export type NotifyState = 'unsupported' | 'default' | 'denied' | 'off' | 'on';

const OLD_OFF_KEY = 'relay.notify.off';   // раньше «выключено на устройстве» жило здесь; теперь prefs.notify.web
const BG_KEY = 'relay.notify.bg';   // «когда вкладка закрыта» (Web Push): по умолчанию включено
const supported = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';
  return getPrefs().notify.web ? 'on' : 'off';
}

/** Хочет ли пользователь push при закрытой вкладке (отдельно от уведомлений в браузере). */
export function bgWanted(): boolean {
  try { return localStorage.getItem(BG_KEY) !== '0'; } catch { return true; }
}

const toBytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Подписка Web Push этого браузера → сервер (вместе с заглушёнными чатами). Без сети — молча, повторим при следующем старте. */
async function syncSubscription(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await (await fetch('/push/key')).json() as { key: string };
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  }
  const res = await fetch('/push/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sub.toJSON(), muted: getGlobal().muted }) });
  setGlobal({ pushReady: res.ok });
}

async function dropSubscription(): Promise<void> {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) return;
  await fetch('/push/subscription', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe();
  setGlobal({ pushReady: false });
}

const quietly = (p: Promise<unknown>) => { p.catch((e) => console.warn('push:', String(e))); };

/** Старт приложения: состояние в global, подписка обновляется, клики по уведомлениям открывают чат. */
export function startNotify(openChat: (id: number) => void): void {
  // единый источник — prefs.notify.web: старый флаг переносим один раз и удаляем
  try { if (localStorage.getItem(OLD_OFF_KEY) !== null) { if (localStorage.getItem(OLD_OFF_KEY) === '1') setPref('notify.web', false); localStorage.removeItem(OLD_OFF_KEY); } } catch { /* ok */ }
  subscribePrefs(() => { const n = notifyState(); if (n !== getGlobal().notify) setGlobal({ notify: n }); });   // «web» сменили в другой вкладке
  setGlobal({ notify: notifyState() });
  if (getGlobal().notify === 'on' && getPrefs().notify.web && bgWanted()) quietly(syncSubscription());
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'openChat') openChat(Number(e.data.chatId));
  });
}

/** Переключатель в настройках. Первое включение спрашивает разрешение браузера. */
export async function setNotify(on: boolean): Promise<void> {
  if (!supported()) return;
  setPref('notify.web', on);
  if (on && Notification.permission === 'default') await Notification.requestPermission();
  const state = notifyState();
  setGlobal({ notify: state });
  if (state === 'on' && bgWanted()) quietly(syncSubscription());
  else if (!on) quietly(dropSubscription());
}

/** «Когда вкладка закрыта»: подписка Web Push этого браузера. Ошибки подписки — в pushReady=false, переключатель не врёт. */
export async function setBackground(on: boolean): Promise<void> {
  try { localStorage.setItem(BG_KEY, on ? '1' : '0'); } catch { /* ok */ }
  if (!supported()) return;
  try {
    if (on && getGlobal().notify === 'on') await syncSubscription();
    else if (!on) await dropSubscription();
  } catch (e) { console.warn('push:', String(e)); setGlobal({ pushReady: false }); }
}

/** Список заглушённых изменился — сервер должен знать, кому не слать push. */
export function syncMuted(): void {
  if (getGlobal().notify === 'on' && bgWanted()) quietly(syncSubscription());
}

const FRESH_MS = 2 * 60_000;   // догоняющая синхронизация после долгого офлайна не засыпает уведомлениями

/** Пришло чужое сообщение (по патчу списка чатов): показать, если окно не в фокусе. */
export function notifyIncoming(chat: { id: number; title: string; muted: boolean }, m: { id: number; body: string; kind?: string; attachmentName?: string | null; createdAt: string }): void {
  if (Date.now() - Date.parse(m.createdAt) > FRESH_MS) return;
  const g = getGlobal();
  const kind = g.chats.find((c) => c.id === chat.id)?.kind === 'group' ? 'group' : 'direct';
  const plan = planIncoming({ state: g.notify, device: getPrefs().notify, chatMuted: chat.muted, pref: g.settings.notify[kind], hasFocus: document.hasFocus() });
  if (!plan.show) return;
  const text = m.kind === 'photo' ? (m.body ? '🖼 ' + m.body : 'Фотография') : m.kind === 'file' ? '📎 ' + (m.body || m.attachmentName || 'Файл') : m.body;
  const t = notifyText({ title: chat.title, text }, { preview: plan.preview, hideText: getPrefs().screen.hideNotifyText });
  quietly(navigator.serviceWorker.ready.then((reg) => reg.showNotification(t.title, { body: t.body, tag: 'chat-' + chat.id, data: { chatId: chat.id } })));
  playNotifySound(plan.volume);
}
