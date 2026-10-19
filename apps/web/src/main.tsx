import { installJoinLinks } from './ui/group/JoinLink';
import { startMuteTimers } from './mute';
import { refreshMyMusic } from './music';
import { configureSpoilers, configureStickers, installSpoilers, loadPattern } from '@relay/ui';
import { fetchBuild, onVisible, startUpdateCheck } from './update';
import { claimMediaCache, sendMediaPolicy } from './storageInfo';
import { getPrefs, isDark, subscribePrefs, type Prefs } from './prefs';
import { enableStrictDom } from '@relay/ui';
import { render } from 'preact';
import { startData } from './data';
import { installErrorCapture } from './devtools/metrics';
import { getGlobal, setGlobal, type Me } from './global';
import * as nav from './nav';
import { startScreenBlur } from './screenBlur';
import { startSettingsData } from './settingsData';
import { startTitle } from './title';
import { App } from './ui/App';

declare const __DEV__: boolean;
declare const __BUILD__: string;

// dev-сборка: проверка дисциплины measure/mutate (чтение раскладки в фазе записи и наоборот)
if (__DEV__) enableStrictDom({ ignore: /twallpaper/ });

// ошибки главного потока — всегда, в кольцо на 200 (раздел «Для разработчиков» → «Ошибки»)
installErrorCapture();

const ME_KEY = 'relay.me';

function start(me: Me): void {
  void claimMediaCache(me.userId);
  setGlobal({ me, boot: 'app' });
  startData(me);
  startMuteTimers();   // «Отключить звук» на время: вышедшие сроки — включить, остальным — таймеры
  startSettingsData(me);
  installJoinLinks();
  void refreshMyMusic();   // мои треки в профиле — для кнопки в плеере
}

async function boot(): Promise<void> {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // политика кэша вложений — SW при каждом старте и при каждой смене настройки
  let policy = '';
  const pushPolicy = (p: Prefs) => { const k = JSON.stringify(p.media); if (k !== policy) { policy = k; sendMediaPolicy(p.media); } };
  pushPolicy(getPrefs());
  subscribePrefs(pushPolicy);
  // Уже входили на этом устройстве — стартуем сразу из локальных данных, как Telegram: первый кадр —
  // готовый список и открытый чат, а не пустое окно на время запроса. Сеанс сверяем в фоне.
  let cached: Me | null = null;
  try { cached = JSON.parse(localStorage.getItem(ME_KEY) ?? 'null'); } catch { cached = null; }
  if (cached) {
    start(cached);
    fetch('/me').then(async (res) => {
      if (res.status === 401) { localStorage.removeItem(ME_KEY); location.reload(); return; }   // сеанс истёк — на вход
      if (!res.ok) return;
      const fresh = (await res.json()) as Me;
      localStorage.setItem(ME_KEY, JSON.stringify(fresh));
      if (fresh.userId !== cached.userId) location.reload();   // в другой вкладке вошли другим пользователем
      else if (fresh.name !== cached.name) setGlobal({ me: fresh });
    }).catch(() => { /* нет сети — работаем офлайн */ });
    return;
  }
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
  start(me);
}

// вход завершён (ui/auth): сеанс уже в cookie — узнаём, кто мы, и запускаем приложение без перезагрузки
window.addEventListener('relay:signed-in', () => {
  void fetch('/me').then(async (res) => {
    if (!res.ok) { location.reload(); return; }
    const me = (await res.json()) as Me;
    localStorage.setItem(ME_KEY, JSON.stringify(me));
    start(me);
  }).catch(() => location.reload());
});

nav.installNav({ get: () => getGlobal().sidebarView, set: (p) => setGlobal({ sidebarView: p }), escBusy: () => getGlobal().infoOpen && !!getGlobal().openChatId });
if (__DEV__) (window as unknown as { __nav: typeof nav }).__nav = nav;   // для ручной проверки навигации
// dev: раздел «Для разработчиков» для проверок — что сейчас в журнале и что ничего не работает при закрытом разделе
if (__DEV__) void import('./devtools/session').then((s) => import('./devtools/metrics').then((m) => {
  (window as unknown as { __dev: object }).__dev = { snapshot: s.devSnapshot, running: () => s.devRunning() || m.metricsRunning() };
}));
startTitle();
// спойлеры: частицы рисует воркер (как в Telegram Web K); без него — CSS-точки
configureSpoilers({ workerUrl: '/spoiler.worker.js' });
configureStickers({ base: '/stickers/', wasmUrl: '/dotlottie-player.wasm' });
installSpoilers();
startUpdateCheck({ current: __BUILD__, fetchBuild, onUpdate: () => setGlobal({ updateReady: true }), onVisible });
startScreenBlur();
// узор обоев — файлом: начинаем грузить до первого рендера, чтобы он проявился вместе с градиентом
void loadPattern(getPrefs().wallpaper[isDark(getPrefs().theme) ? 'dark' : 'light'].pattern).catch(() => {});
render(<App />, document.getElementById('app')!);
boot();
