import { enableStrictDom } from '@relay/ui';
import { render } from 'preact';
import { startData } from './data';
import { getGlobal, setGlobal, type Me } from './global';
import * as nav from './nav';
import { App } from './ui/App';

declare const __DEV__: boolean;

// dev-сборка: проверка дисциплины measure/mutate (чтение раскладки в фазе записи и наоборот)
if (__DEV__) enableStrictDom({ ignore: /twallpaper/ });

const ME_KEY = 'relay.me';

async function boot(): Promise<void> {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let me: Me | null = null;
  try {
    const res = await fetch('/me');
    if (res.status === 401) {
      localStorage.removeItem(ME_KEY);
      setGlobal({ boot: 'login' });
      return;
    }
    me = (await res.json()) as Me;
    localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // нет сети: работаем как последний вошедший пользователь — данные уже в IndexedDB
    try { me = JSON.parse(localStorage.getItem(ME_KEY) ?? 'null'); } catch { me = null; }
    if (!me) { setGlobal({ boot: 'login' }); return; }
  }
  setGlobal({ me, boot: 'app' });
  startData(me);
}

nav.installNav({ get: () => getGlobal().sidebarView, set: (p) => setGlobal({ sidebarView: p }), escBusy: () => getGlobal().infoOpen && !!getGlobal().openChatId });
if (__DEV__) (window as unknown as { __nav: typeof nav }).__nav = nav;   // для ручной проверки навигации
render(<App />, document.getElementById('app')!);
boot();
