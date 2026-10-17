import { getPrefs, subscribePrefs } from './prefs';

/** Размытие экрана при потере фокуса: логика без DOM — таймер задержки и состояние. */
export interface BlurDeps {
  enabled: () => boolean;
  delaySec: () => number;
  apply: (on: boolean) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export function createBlurController(d: BlurDeps) {
  let timer: unknown = null;
  let on = false;
  const cancel = () => { if (timer !== null) { d.clearTimer(timer); timer = null; } };
  const set = (v: boolean) => { if (v !== on) { on = v; d.apply(v); } };
  return {
    /** Окно потеряло фокус / вкладка скрыта. */
    lost() {
      if (!d.enabled() || on || timer !== null) return;
      const ms = d.delaySec() * 1000;
      if (ms <= 0) set(true);
      else timer = d.setTimer(() => { timer = null; set(true); }, ms);
    },
    /** Фокус вернулся, нажали клавишу или клик по слою. */
    back() { cancel(); set(false); },
    isOn: () => on,
  };
}

const ATTR = 'data-screen-blur';

/** Решение «проглотить» событие указателя/клавиши — чистая логика для тестов. */
export function createSwallow(setTimer: (fn: () => void, ms: number) => unknown, clearTimer: (t: unknown) => void) {
  let on = false;
  let t: unknown = null;
  const off = () => { on = false; if (t !== null) { clearTimer(t); t = null; } };
  return {
    /** pointerdown по слою: ближайший click проглотить, но не дольше 500 мс. */
    arm() { off(); on = true; t = setTimer(() => { t = null; on = false; }, 500); },
    /** pointerup/pointercancel: click, если будет, придёт сразу после — флаг сам погаснет по таймеру. */
    release() {},
    /** click: true — проглотить. */
    take(): boolean { const was = on; off(); return was; },
    cancel: off,
    isOn: () => on,
  };
}

// скрытое под размытием не читается скринридером и не берёт фокус: помечаем детей оболочки, снимаем только своё
let marked: Element[] = [];
function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute(ATTR, '1'); else root.removeAttribute(ATTR);
  if (on) {
    marked = [...document.querySelectorAll('.rl-shell > :not(.rl-shell-veil)')].filter((el) => !el.hasAttribute('inert'));
    for (const el of marked) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
  } else {
    for (const el of marked) { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    marked = [];
  }
}

export function startScreenBlur(): void {
  const ctl = createBlurController({
    enabled: () => getPrefs().screen.blur,
    delaySec: () => getPrefs().screen.blurDelay,
    apply,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const sw = createSwallow((fn, ms) => setTimeout(fn, ms), (t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  window.addEventListener('blur', () => ctl.lost());
  window.addEventListener('focus', () => ctl.back());
  document.addEventListener('visibilitychange', () => { if (document.hidden) ctl.lost(); else ctl.back(); });
  // первая клавиша при размытии только снимает его и дальше не идёт (Tab не попадает в скрытое)
  document.addEventListener('keydown', (e) => {
    if (!ctl.isOn()) return;
    e.preventDefault(); e.stopPropagation();
    ctl.back();
  }, true);
  // клик по слою снимает размытие и не доходит до того, что под ним
  document.addEventListener('pointerdown', (e) => {
    if (!ctl.isOn()) return;
    e.preventDefault(); e.stopPropagation();
    if ((e.target as Element | null)?.closest?.('.rl-shell-veil')) sw.arm();
    ctl.back();
  }, true);
  const drop = () => sw.release();
  document.addEventListener('pointercancel', () => sw.cancel(), true);
  document.addEventListener('pointerup', drop, true);
  document.addEventListener('click', (e) => {
    if (!sw.take()) return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  // размытие выключили в настройках — снять сразу
  subscribePrefs((p) => { if (!p.screen.blur) ctl.back(); });
}
