// Старт интерфейса. main.tsx грузит этот модуль через import() — после того как слой данных уже запущен:
// пока браузер разбирает и выполняет код интерфейса, движок отдаёт список чатов, и первый же кадр App рисует строки.
import { configureLottie, configureSpoilers, configureVoice, configureStickers, installSpoilers, loadPattern, onFullyIdle } from '@relay/ui';
import { render } from 'preact';
import { asset } from '../assets';
import { getGlobal, subscribeGlobal } from '../global';
import { getPrefs, isDark, subscribePrefs, type Prefs } from '../prefs';
import { warmSounds } from '../sound';
import { markUiRendered } from '../uiReady';
import { App } from './App';
import { installJoinLinks } from './group/JoinLink';
import { preloadLazy } from './lazy';

declare const __DEV__: boolean;

// спойлеры: частицы рисует воркер (как в Telegram Web K); без него — CSS-точки
configureSpoilers({ workerUrl: asset('spoiler.worker.js') });
// голосовые: ворклет — файлом сборки, не из blob: (CSP)
configureVoice({ workletUrl: asset('voice.worklet.js') });
configureStickers({ base: '/stickers/' });
// анимированные стикеры: tlottie в пуле воркеров
configureLottie({ workerUrl: asset('lottie.worker.js'), wasm: { simd: asset('tlottie.wasm'), noSimd: asset('tlottie-no-simd.wasm') } });
installSpoilers();
installJoinLinks();   // ссылки-приглашения: адрес /join/… при загрузке и клики по ним в сообщениях
// узор обоев — файлом: начинаем грузить до первого рендера, чтобы он проявился вместе с градиентом
void loadPattern(getPrefs().wallpaper[isDark(getPrefs().theme) ? 'dark' : 'light'].pattern).catch(() => {});
render(<App />, document.getElementById('app')!);
// кадр App отрисован (рендер — в мутациях кадра, два rAF — после него)
requestAnimationFrame(() => requestAnimationFrame(markUiRendered));

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
  const wpOf = (p: Prefs) => JSON.stringify([p.theme, p.wallpaper]);
  let wpKey = wpOf(getPrefs());
  subscribePrefs((p) => { const k = wpOf(p); if (k !== wpKey) { wpKey = k; resnap(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', resnap);
  // время до списка — следующий запуск решит, рисовать ли в каркасе скелетон (boot.js: дольше 250 мс)
  const whenChats = (fn: () => void) => { if (getGlobal().chatsLoaded) { fn(); return; } const off = subscribeGlobal(() => { if (getGlobal().chatsLoaded) { off(); fn(); } }); };
  whenChats(() => {
    try { localStorage.setItem('relay.listMs', String(Math.round(performance.now()))); } catch { /* приватный режим */ }
    onFullyIdle(saveWallpaper);
  });
  // кадр App с приложением (boot = app) отрисован: колонки проявляются 300 мс, потом — и обои приложения встали
  // (они ждут узор — Wallpaper waitPattern; до того видны обои каркаса), но не дольше 3 с
  const afterAppFrame = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    // dev: каркас совпадает с первым кадром приложения? (поменяли шапку или колонку — пора обновить shell.html)
    if (__DEV__) void import('../devtools/shellMarkup').then((m) => {
      const app = document.querySelector('#app > .rl-shell'), own = shell?.querySelector('.rl-shell');
      if (!app || !own) return;
      const snap = m.snapshotShell(app);   // именно первый кадр: позже в колонке будут вкладки папок и строки
      (window as unknown as { __relayShellSnapshot: () => string }).__relayShellSnapshot = () => snap;
      const d = m.shellDiff(m.shellSignature(own), m.shellSignature(app));
      if (d) console.warn('[shell] каркас (public/shell.html) не совпадает с первым кадром приложения:', d, '— обновить: copy(__relayShellSnapshot()) в консоли сразу после загрузки и вставить в public/shell.html');
    });
    setTimeout(() => {
      const has = () => !!document.querySelector('#app .rl-tw canvas');
      if (has()) { drop(); return; }
      const tw = document.querySelector('#app .rl-tw');
      const mo = new MutationObserver(() => { if (has()) { mo.disconnect(); clearTimeout(t); drop(); } });
      if (tw) mo.observe(tw, { childList: true });
      const t = setTimeout(() => { mo.disconnect(); drop(); }, 3000);
    }, 350);
  }));
  if (!shell || !root.hasAttribute('data-shell')) drop();
  else {
    // данные стартуют раньше интерфейса: boot уже может быть 'app' к этому моменту — смотрим и сразу, и по подписке
    const check = (): boolean => {
      const b = getGlobal().boot;
      if (b === 'login') { drop(); return true; }
      if (b === 'app') { afterAppFrame(); return true; }
      return false;
    };
    if (!check()) { const off = subscribeGlobal(() => { if (check()) off(); }); }
  }
}

// звуки сообщений: вывод звука заводится заранее, в простое — иначе первая отправка ждёт его в обработчике (sound.ts)
onFullyIdle(() => { if (getPrefs().notify.sound) warmSounds(); });
// настройки, эмодзи и стикеры, управление группой — чанками (ui/lazy.tsx): к первому открытию они уже загружены.
// После первого экрана — когда пришёл список чатов (первое простое наступает раньше, пока ждём данные)
{
  const go = () => onFullyIdle(() => preloadLazy(onFullyIdle));
  if (getGlobal().chatsLoaded) go();
  else { const off = subscribeGlobal(() => { if (getGlobal().chatsLoaded) { off(); go(); } }); }
}
