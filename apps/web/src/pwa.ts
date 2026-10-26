import { setGlobal } from './global';

/**
 * Установка как приложения (PWA). Браузер присылает beforeinstallprompt один раз и рано — слушаем с загрузки
 * модуля; меню показывает «Установить Relay», пока приглашение есть. После установки оно больше не приходит.
 */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferred: InstallPrompt | null = null;

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();   // своя кнопка в меню вместо мини-плашки браузера
  deferred = e as InstallPrompt;
  setGlobal({ installable: true });
});
addEventListener('appinstalled', () => { deferred = null; setGlobal({ installable: false }); });

export async function installApp(): Promise<void> {
  const p = deferred;
  if (!p) return;
  deferred = null;   // приглашение одноразовое: после ответа браузер пришлёт новое, если снова можно
  setGlobal({ installable: false });
  await p.prompt();
}

/** Запуск установленного приложения, когда окно уже открыто (launch_handler: focus-existing): адрес приходит сюда, а не новой вкладкой. */
type LaunchParams = { targetURL?: string };
export function onLaunch(open: (url: URL) => void): void {
  const q = (window as Window & { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
  q?.setConsumer((p) => { if (p.targetURL) open(new URL(p.targetURL)); });
}
