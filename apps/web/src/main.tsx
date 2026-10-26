// Старт — сначала данные, потом интерфейс. Этот модуль — только слой данных (движок, состояние, сеанс): без
// компонентов и без UI-кита, поэтому он маленький и выполняется быстро. Данные запускаются сразу (boot()), а
// интерфейс (ui/start.tsx) грузится следом через import(): пока браузер разбирает его код, движок (уже открытый
// ранним стартом из boot.js) отдаёт список чатов — и первый же кадр App рисует строки, а не пустой список.
// первым: политика Trusted Types до любой записи в DOM (trustedTypes.ts)
import './trustedTypes';
import './pwa';   // beforeinstallprompt приходит рано — слушаем с первых строк
import { startMuteTimers } from './mute';
import { startOwnMusic } from './profileLists';
import { fetchBuild, onVisible, startUpdateCheck } from './update';
import { claimMediaCache, sendMediaPolicy } from './storageInfo';
import { getPrefs, subscribePrefs, type Prefs } from './prefs';
import { enableStrictDom } from '@relay/ui/src/strict.js';
import { closeAllChats, openChat, startData } from './data';
import { installErrorCapture } from './devtools/metrics';
import { getGlobal, isPhone, setGlobal, subscribeGlobal, type Me } from './global';
import * as nav from './nav';
import { startScreenBlur } from './screenBlur';
import { startSettingsData } from './settingsData';
import { startTitle } from './title';
import { warmEmoji } from '@relay/protocol';
import { Login } from './ui/Login';
import { installDeviceFetch, startDeviceAuth } from './deviceAuth';
import { uiRendered } from './uiReady';

// до первого запроса: 401 «обнови доступ» — подпись ключом устройства и повтор, а не экран входа
installDeviceFetch();

declare const __DEV__: boolean;
declare const __BUILD__: string;

// dev-сборка: проверка дисциплины measure/mutate (чтение раскладки в фазе записи и наоборот)
if (__DEV__) enableStrictDom({ ignore: /twallpaper/ });

// ошибки главного потока — всегда, в кольцо на 200 (раздел «Для разработчиков» → «Ошибки»)
installErrorCapture();

const ME_KEY = 'relay.me';

function start(me: Me, enter: 'login' | 'reload' = 'reload'): void {
  void claimMediaCache(me.userId);
  setGlobal({ me, boot: 'app', enter });
  // анимации входа доиграли — через секунду после первого кадра интерфейса (он грузится после данных)
  void uiRendered.then(() => setTimeout(() => setGlobal({ enter: null }), 1000));
  startDeviceAuth();   // привязать сеанс к ключу этого браузера и держать короткий доступ свежим
  startData(me, enter !== 'login');   // после входа — список, а не чат из адреса прошлого сеанса
  startMuteTimers();   // «Отключить звук» на время: таймер до ближайшего срока — перерисовать, когда чат включится
  startSettingsData(me);
  startOwnMusic(me.userId);   // мои треки в профиле — для кнопки в плеере
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
    // сеанс сверяет движок: он сам спрашивает /me после подключения (свежий профиль придёт подпиской 'me'),
    // а 401 на любой его запрос — конец сеанса и экран входа (settingsData → onTerminated). Свой запрос здесь — дубль
    start(cached);
    return;
  }
  void Login.preload();   // профиля на устройстве нет — скорее всего, вход: его чанк качается вместе с запросом /me
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
  try { localStorage.removeItem('relay.thisSession'); } catch { /* приватный режим */ }   // новый вход — другой сеанс
  void fetch('/me').then(async (res) => {
    if (!res.ok) { location.reload(); return; }
    const me = (await res.json()) as Me;
    localStorage.setItem(ME_KEY, JSON.stringify(me));
    start(me, 'login');
  }).catch(() => location.reload());
});

nav.installNav({ get: () => getGlobal().sidebarView, set: (p) => setGlobal({ sidebarView: p }), escBusy: () => getGlobal().infoOpen && !!getGlobal().openChatId });
// правая панель «Информация» — свой слой навигации: «Назад» браузера закрывает её, закрытая из интерфейса — снимает запись
let infoLayer = 0;
// телефон: открытый чат — отдельный экран поверх списка (как в Telegram), «Назад» браузера возвращает к списку.
// Запись — под слоями чатов поверх и панели: заводится раньше них, когда чат открылся; на широком экране её нет
let screenLayer = 0;
subscribeGlobal(() => {
  const g = getGlobal(), chat = g.openChatId != null && !g.listLeaving;
  if (chat && !screenLayer && isPhone()) screenLayer = nav.pushLayer('screen', () => { screenLayer = 0; openChat(null); });
  else if (!chat && screenLayer) { const id = screenLayer; screenLayer = 0; nav.closeLayer(id); }
  const open = g.infoOpen && g.openChatId != null;
  if (open && !infoLayer) infoLayer = nav.pushLayer('info', () => { infoLayer = 0; setGlobal({ infoOpen: false }); });
  else if (!open && infoLayer) { const id = infoLayer; infoLayer = 0; nav.closeLayer(id); }
});
// сеанс кончился (экран входа): стек чатов прошлого сеанса закрыть — иначе он держит #chat=… в адресе и показывается после входа
let inApp = false;
subscribeGlobal(() => {
  const app = getGlobal().boot === 'app';
  if (inApp && !app) queueMicrotask(closeAllChats);
  inApp = app;
});
if (__DEV__) (window as unknown as { __nav: typeof nav }).__nav = nav;   // для ручной проверки навигации
// dev: раздел «Для разработчиков» для проверок — что сейчас в журнале и что ничего не работает при закрытом разделе
if (__DEV__) void import('./devtools/session').then((s) => import('./devtools/metrics').then((m) => {
  (window as unknown as { __dev: object }).__dev = { snapshot: s.devSnapshot, running: () => s.devRunning() || m.metricsRunning() };
}));
startTitle();
// регулярка эмодзи (RGI) и сегментатор — заранее, в простое: иначе их первая компиляция ложится на первое открытие чата
{
  const warm = () => { warmEmoji(); };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(warm, { timeout: 5000 }); else setTimeout(warm, 2000);
}
startUpdateCheck({ current: __BUILD__, fetchBuild, onUpdate: () => setGlobal({ updateReady: true }), onVisible });
startScreenBlur();
// данные — сразу; интерфейс — следом (его чанк уже качается: modulepreload в index.html, build.ts)
void boot();
void import('./ui/start');
