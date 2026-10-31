// первым: политика Trusted Types до любой записи в DOM (trustedTypes.ts)
import './trustedTypes';
import './pwa';   // beforeinstallprompt приходит рано — слушаем с первых строк
import { installJoinLinks } from './ui/group/JoinLink';
import { startMuteTimers } from './mute';
import { startOwnMusic } from './profileLists';
import { configureLottie, configureSpoilers, configureVoice, configureStickers, installSpoilers, loadPattern, onFullyIdle } from '@relay/ui';
import { fetchBuild, onVisible, startUpdateCheck } from './update';
import { claimMediaCache, sendMediaPolicy } from './storageInfo';
import { getPrefs, isDark, resolveBase, subscribePrefs, type Prefs } from './prefs';
import { loadCatalog } from './themes/catalog';   // до первого применения темы: выбранная готовая тема — из кэша каталога
import { enableStrictDom } from '@relay/ui';
import { render } from 'preact';
import { closeAllChats, openChat, startData } from './data';
import { installErrorCapture } from './devtools/metrics';
import { getGlobal, isPhone, setGlobal, subscribeGlobal, type Me } from './global';
import * as nav from './nav';
import { endChatSelect } from './chatSelect';
import { startScreenBlur } from './screenBlur';
import { startSettingsData } from './settingsData';
import { startTitle } from './title';
import { warmEmoji } from '@relay/protocol';
import { App } from './ui/App';
import { preloadLazy } from './ui/lazy';
import { Login } from './ui/Login';
import { warmSounds } from './sound';
import { asset } from './assets';
import { installDeviceFetch, startDeviceAuth } from './deviceAuth';

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
  setTimeout(() => setGlobal({ enter: null }), 1000);   // анимации входа доиграли
  startDeviceAuth();   // привязать сеанс к ключу этого браузера и держать короткий доступ свежим
  startData(me, enter !== 'login');   // после входа — список, а не чат из адреса прошлого сеанса
  void loadCatalog();   // готовые темы: свежий каталог (кэш уже применён)
  startMuteTimers();   // «Отключить звук» на время: таймер до ближайшего срока — перерисовать, когда чат включится
  startSettingsData(me);
  installJoinLinks();
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

// Esc по слоям: меню, окна, поле ввода (ответ, панель формата, упоминания), эмодзи — сами, до window; правая панель —
// escBusy; выбор сообщений и поиск в чате — свои обработчики на window (позже nav, поэтому здесь пропускаем их);
// затем выбор чатов в списке слева (поиск смотрим только в текущей колонке стека: нижние чаты смонтированы, их поиск не слушает Esc); затем обычная навигация (закрыть чат, «Назад» страницы).
const escChatSelect = () => {
  const s = getGlobal();
  if (!s.chatSelect || s.selecting || document.querySelector('.app-chatcol[data-current] .rl-csearch')) return false;
  endChatSelect();
  return true;
};
nav.installNav({ get: () => getGlobal().sidebarView, set: (p) => setGlobal({ sidebarView: p }), escBusy: () => getGlobal().infoOpen && !!getGlobal().openChatId, escMode: escChatSelect });
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
// спойлеры: частицы рисует воркер (как в Telegram Web K); без него — CSS-точки
configureSpoilers({ workerUrl: asset('spoiler.worker.js') });
// голосовые: ворклет — файлом сборки, не из blob: (CSP)
configureVoice({ workletUrl: asset('voice.worklet.js') });
configureStickers({ base: '/stickers/' });
// анимированные стикеры: tlottie в пуле воркеров
configureLottie({ workerUrl: asset('lottie.worker.js'), wasm: { simd: asset('tlottie.wasm'), noSimd: asset('tlottie-no-simd.wasm') } });
installSpoilers();
startUpdateCheck({ current: __BUILD__, fetchBuild, onUpdate: () => setGlobal({ updateReady: true }), onVisible });
startScreenBlur();
// узор обоев — файлом: начинаем грузить до первого рендера, чтобы он проявился вместе с градиентом
void loadPattern(getPrefs().themes[resolveBase(getPrefs())].wallpaper.pattern).catch(() => {});
render(<App />, document.getElementById('app')!);
// каркас из index.html (boot.js → html[data-shell]) лежит под приложением, пока его колонки проявляются поверх такой же
// картинки (app-enter-reload, 300 мс), — потом не нужен. Экран входа — сразу без каркаса
{
  const root = document.documentElement, shell = document.getElementById('shell');
  const drop = () => { shell?.remove(); root.removeAttribute('data-shell'); };
  // обои каркаса — снимок настоящих (twallpaper): цвет фона, узор, градиент холста — свой у светлой и тёмной темы
  // (relay.shellWp.light / .dark), boot.js берёт снимок своей темы и ставит переменными CSS до первого кадра.
  // Снимаем в простое после списка, когда обои уже нарисованы, и заново — после смены обоев или темы
  const saveWallpaper = () => {
    const tw = document.querySelector<HTMLElement>('#app .rl-tw'), cv = tw?.querySelector<HTMLCanvasElement>('canvas.tw-canvas');
    if (!tw || !cv || !cv.width) return;
    const v = (k: string) => tw.style.getPropertyValue(k);
    try {
      localStorage.setItem('relay.shellWp.' + (isDark(getPrefs().theme) ? 'dark' : 'light'), JSON.stringify({ bg: v('--tw-background'), image: v('--tw-image'), size: v('--tw-size'), opacity: v('--tw-opacity'), mask: cv.classList.contains('tw-mask'), grad: cv.toDataURL('image/png') }));
    } catch { /* приватный режим, квота */ }
  };
  // обои перерисовываются с переходом (300 мс) — снимок после него, в простое
  let wpTimer: ReturnType<typeof setTimeout> | undefined;
  const resnap = () => { clearTimeout(wpTimer); wpTimer = setTimeout(() => onFullyIdle(saveWallpaper), 1200); };
  const wpOf = (p: Prefs) => JSON.stringify([p.theme, p.themes]);
  let wpKey = wpOf(getPrefs());
  subscribePrefs((p) => { const k = wpOf(p); if (k !== wpKey) { wpKey = k; resnap(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', resnap);
  // время до списка — следующий запуск решит, рисовать ли в каркасе скелетон (boot.js: дольше 250 мс)
  const offWp = subscribeGlobal(() => {
    if (!getGlobal().chatsLoaded) return;
    offWp();
    try { localStorage.setItem('relay.listMs', String(Math.round(performance.now()))); } catch { /* приватный режим */ }
    onFullyIdle(saveWallpaper);
  });
  if (!shell || !root.hasAttribute('data-shell')) drop();
  else {
    const off = subscribeGlobal(() => {
      const b = getGlobal().boot;
      if (b === 'login') { off(); drop(); }
      // кадр приложения отрисован (рендер — в мутациях кадра, два rAF — после него), анимация появления доиграла
      else if (b === 'app') {
        off();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          // dev: каркас совпадает с первым кадром приложения? (поменяли шапку или колонку — пора обновить shell.html)
          if (__DEV__) void import('./devtools/shellMarkup').then((m) => {
            const app = document.querySelector('#app > .rl-shell'), own = shell.querySelector('.rl-shell');
            if (!app || !own) return;
            const snap = m.snapshotShell(app);   // именно первый кадр: позже в колонке будут вкладки папок и строки
            (window as unknown as { __relayShellSnapshot: () => string }).__relayShellSnapshot = () => snap;
            const d = m.shellDiff(m.shellSignature(own), m.shellSignature(app));
            if (d) console.warn('[shell] каркас (public/shell.html) не совпадает с первым кадром приложения:', d, '— обновить: copy(__relayShellSnapshot()) в консоли сразу после загрузки и вставить в public/shell.html');
          });
          // и обои приложения встали (они ждут узор — Wallpaper waitPattern; до того видны обои каркаса), но не дольше 3 с
          setTimeout(() => {
            const has = () => !!document.querySelector('#app .rl-tw canvas');
            if (has()) { drop(); return; }
            const tw = document.querySelector('#app .rl-tw');
            const mo = new MutationObserver(() => { if (has()) { mo.disconnect(); clearTimeout(t); drop(); } });
            if (tw) mo.observe(tw, { childList: true });
            const t = setTimeout(() => { mo.disconnect(); drop(); }, 3000);
          }, 350);
        }));
      }
    });
  }
}
boot();
// звуки сообщений: вывод звука заводится заранее, в простое — иначе первая отправка ждёт его в обработчике (sound.ts)
onFullyIdle(() => { if (getPrefs().notify.sound) warmSounds(); });
// настройки, эмодзи и стикеры, управление группой — чанками (ui/lazy.tsx): к первому открытию они уже загружены.
// После первого экрана — когда пришёл список чатов (первое простое наступает раньше, пока ждём данные)
{
  const off = subscribeGlobal(() => { if (getGlobal().chatsLoaded) { off(); onFullyIdle(() => preloadLazy(onFullyIdle)); } });
}
