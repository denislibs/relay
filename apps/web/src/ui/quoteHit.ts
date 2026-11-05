import { locateQuote } from '@relay/protocol';
import { pointAt } from '@relay/ui';

const STEPS = 4, HOLD_MS = 900, STEP_MS = 160;
let timer: ReturnType<typeof setTimeout> | null = null;
type Registry = { set(n: string, h: unknown): void; delete(n: string): void };
const registry = (): { reg: Registry; make: (r: Range) => unknown } | null => {
  const reg = (CSS as unknown as { highlights?: Registry }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
  return reg && Ctor ? { reg, make: (r) => new Ctor(r) } : null;
};

/**
 * Подсветить цитируемый фрагмент в исходном сообщении: выделение браузера (Custom Highlight API), DOM не меняется, строка не
 * перерисовывается; угасает ступенями — переходов у ::highlight нет. false — фрагмента в тексте уже нет (текст изменили) или
 * API нет: подсвечивается всё сообщение, как обычный переход. В свёрнутой цитате — сначала разворачиваем её.
 */
export function hitQuote(row: Element, body: string, q: { text: string; offset: number }): boolean {
  const api = registry(), at = locateQuote(body, q.text, q.offset);
  if (!api || at < 0) return false;
  for (const el of row.querySelectorAll('.rl-bubble-text, .rl-media-caption')) {
    const [a, ao] = pointAt(el, at) as [Node, number], [b, bo] = pointAt(el, at + q.text.length) as [Node, number];
    const r = document.createRange();
    r.setStart(a, ao); r.setEnd(b, bo);
    // дата показана иначе, чем написана: смещения DOM и текста расходятся — тогда всё сообщение
    if (r.toString().replace(/\s+/g, '') !== q.text.replace(/\s+/g, '')) continue;
    (a.nodeType === 1 ? a as Element : a.parentElement)?.closest<HTMLElement>('.rl-bq-fold:not(.rl-bq-open)')?.click();
    if (timer) clearTimeout(timer);
    for (let i = 1; i <= STEPS; i++) api.reg.delete('rl-quote-hit-' + i);
    const hl = api.make(r);
    let step = 1;
    api.reg.set('rl-quote-hit-1', hl);
    const next = () => {
      api.reg.delete('rl-quote-hit-' + step);
      if (++step > STEPS) { timer = null; return; }
      api.reg.set('rl-quote-hit-' + step, hl);
      timer = setTimeout(next, STEP_MS);
    };
    timer = setTimeout(next, HOLD_MS);
    return true;
  }
  return false;
}
