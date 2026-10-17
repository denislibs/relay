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
    /** click: true — проглотить. */
    take(): boolean { const was = on; off(); return was; },
    cancel: off,
    isOn: () => on,
  };
}

// скрытое под размытием не читается скринридером и не берёт фокус: помечаем детей оболочки, снимаем только своё
let marked: { el: Element; aria: string | null }[] = [];
function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute(ATTR, '1'); else root.removeAttribute(ATTR);
  if (on) {
    // дети оболочки и все хосты диалогов (.rl-dialog-host: портал в body или корень в #app); слой выше всех (z 2000) перехватывает указатель
    marked = [...document.querySelectorAll('.rl-shell > :not(.rl-shell-veil), .rl-dialog-host')].filter((el) => !el.hasAttribute('inert'))
      .map((el) => ({ el, aria: el.getAttribute('aria-hidden') }));
    for (const m of marked) { m.el.setAttribute('inert', ''); m.el.setAttribute('aria-hidden', 'true'); }
  } else {
    for (const m of marked) { m.el.removeAttribute('inert'); if (m.aria === null) m.el.removeAttribute('aria-hidden'); else m.el.setAttribute('aria-hidden', m.aria); }
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
    sw.arm();   // любой pointerdown при размытии: ближайший click не дойдёт до содержимого
    ctl.back();
  }, true);
  document.addEventListener('pointercancel', () => sw.cancel(), true);
  document.addEventListener('click', (e) => {
    if (!sw.take()) return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  // размытие выключили в настройках — снять сразу
  subscribePrefs((p) => { if (!p.screen.blur) ctl.back(); });
}
