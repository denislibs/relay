// Пункт настроек, открытый из поиска: строка встаёт по центру прокрутки страницы и вспыхивает фоном акцента (≈1,6 с).
// Строка может появиться позже страницы (правила с сервера, сеансы) — ждём её до 3 с. Чтения раскладки — в
// requestMeasure, записи — в requestMutation; вспышка — после перехода страниц, без анимаций её нет.
import { onHeavyAnimationEnd, reducedMotion, requestMeasure, requestMutation } from '@relay/ui';

const WAIT_MS = 3000;
const FLASH_MS = 1600;

let cancel: (() => void) | null = null;

/** Найти на странице path строку data-setting=anchor, прокрутить к ней и подсветить. Новый вызов отменяет прежний. */
export function flashSetting(path: string, anchor: string): void {
  cancel?.();
  const sel = `.rl-slide[data-slide="${CSS.escape(path)}"] [data-setting="${CSS.escape(anchor)}"]`;
  const find = () => document.querySelector<HTMLElement>(sel);
  let obs: MutationObserver | null = null, timer: ReturnType<typeof setTimeout> | undefined, done = false;
  const stop = () => { done = true; obs?.disconnect(); clearTimeout(timer); if (cancel === stop) cancel = null; };
  cancel = stop;
  requestMeasure(() => {
    if (done) return;
    const el = find();
    if (el) { stop(); reveal(el, false); return; }
    obs = new MutationObserver(() => { const e = find(); if (e) { stop(); reveal(e, true); } });
    obs.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(stop, WAIT_MS);
  });
}

/** late — строка пришла, когда страница уже на экране: туда плавно, иначе страница сразу открывается на ней. */
function reveal(el: HTMLElement, late: boolean): void {
  requestMeasure(() => {
    const box = el.closest<HTMLElement>('.rl-settings');
    if (!box) return;
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    const top = Math.max(0, box.scrollTop + r.top - b.top - (b.height - r.height) / 2);
    requestMutation(() => {
      if (late && !reducedMotion()) box.scrollTo({ top, behavior: 'smooth' });
      else box.scrollTop = top;
      if (!reducedMotion()) onHeavyAnimationEnd(() => requestMutation(() => flash(el)));
    });
  });
}

function flash(el: HTMLElement): void {
  // подраздел (карточка с заголовком) подсвечивается текстом заголовка, строка — фоном
  const target = el.tagName === 'SECTION' ? el.querySelector<HTMLElement>('.rl-sect-title') : el;
  if (!target) return;
  const cls = target === el ? 'app-setting-flash' : 'app-setting-flash-title';
  target.classList.remove(cls);
  target.classList.add(cls);
  setTimeout(() => requestMutation(() => target.classList.remove(cls)), FLASH_MS);
}
