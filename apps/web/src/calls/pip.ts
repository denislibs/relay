import { installTrustedTypes } from '../trustedTypes';

/**
 * «Картинка в картинке» во время звонка (этап 4 docs/plans/2026-11-07-relay-calls-features.md).
 * Chrome / Edge: Document Picture-in-Picture — плавающее окно с нашей разметкой (видео собеседника, «Микрофон»,
 * «Завершить»); открывается кнопкой и само, когда уходишь с вкладки (mediaSession «enterpictureinpicture» — Chrome
 * разрешает это странице, у которой включены камера или микрофон). Остальные браузеры — обычный PiP видео по кнопке.
 */

type DocPip = { requestWindow(o?: { width?: number; height?: number }): Promise<Window>; window: Window | null };
const docPip = (): DocPip | null => (globalThis as { documentPictureInPicture?: DocPip }).documentPictureInPicture ?? null;

export type PipKind = 'document' | 'video' | null;
export function pipKind(): PipKind {
  if (typeof window === 'undefined') return null;
  if (docPip()) return 'document';
  return typeof document !== 'undefined' && document.pictureInPictureEnabled ? 'video' : null;
}

let win: Window | null = null;
let unmount: (() => void) | null = null;

/** Стили и тема страницы — в окно PiP (та же сборка: адреса с хэшем, integrity сохраняется). */
function adopt(w: Window): void {
  const d = w.document;
  for (const el of document.head.querySelectorAll('link[rel="stylesheet"], style')) d.head.appendChild(el.cloneNode(true));
  for (const a of document.documentElement.attributes) d.documentElement.setAttribute(a.name, a.value);
  d.body.className = 'rl app-pip-body';
  d.title = document.title;
}

/**
 * Открыть окно: mount рисует содержимое в корень окна и возвращает «размонтировать». Нужен жест пользователя (или
 * mediaSession). Без Document PiP — fallbackVideo: обычный PiP этого видео.
 */
export async function openPip(mount: (root: HTMLElement) => () => void, fallbackVideo: () => HTMLVideoElement | null, size = { width: 360, height: 240 }): Promise<boolean> {
  const dp = docPip();
  if (dp) {
    if (win && !win.closed) { win.focus(); return true; }
    const w = await dp.requestWindow(size);
    installTrustedTypes(w as never);   // CSP окна — от страницы (require-trusted-types): свои политики в его мире
    adopt(w);
    const root = w.document.createElement('div');
    root.className = 'app-pip';
    w.document.body.appendChild(root);
    win = w;
    unmount = mount(root);
    w.addEventListener('pagehide', () => { unmount?.(); unmount = null; if (win === w) win = null; }, { once: true });
    return true;
  }
  const v = fallbackVideo();
  if (v && document.pictureInPictureEnabled && v.readyState >= 1) { await v.requestPictureInPicture(); return true; }
  return false;
}

export function closePip(): void {
  if (win && !win.closed) win.close();
  win = null;
  if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
}

export const pipOpen = (): boolean => !!(win && !win.closed) || !!document.pictureInPictureElement;

/** Автоматически при уходе с вкладки (пока идёт звонок с камерой или микрофоном); null — снять. */
export function autoPip(open: (() => void) | null): void {
  const ms = navigator.mediaSession as MediaSession & { setActionHandler(a: string, h: (() => void) | null): void } | undefined;
  try { ms?.setActionHandler('enterpictureinpicture', open); } catch { /* браузер не знает такого действия */ }
}
