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
      if (!d.enabled() || on) return;
      cancel();
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
const SELECTOR = '.rl-sidecard-body, .rl-settings, .rl-feed, .rl-asidecard';

function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute(ATTR, '1'); else root.removeAttribute(ATTR);
  // скрытое под размытием не читается скринридером
  document.querySelectorAll(SELECTOR).forEach((el) => { if (on) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); });
}

export function startScreenBlur(): void {
  const ctl = createBlurController({
    enabled: () => getPrefs().screen.blur,
    delaySec: () => getPrefs().screen.blurDelay,
    apply,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  window.addEventListener('blur', () => ctl.lost());
  window.addEventListener('focus', () => ctl.back());
  document.addEventListener('visibilitychange', () => { if (document.hidden) ctl.lost(); else ctl.back(); });
  document.addEventListener('keydown', () => ctl.back(), true);
  // клик по слою снимает размытие и не доходит до того, что под ним
  let swallow = false;
  document.addEventListener('pointerdown', (e) => {
    if (!ctl.isOn()) return;
    e.preventDefault(); e.stopPropagation();
    swallow = true;
    ctl.back();
  }, true);
  document.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault(); e.stopPropagation();
  }, true);
  // размытие выключили в настройках — снять сразу
  subscribePrefs((p) => { if (!p.screen.blur) ctl.back(); });
}
