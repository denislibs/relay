import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/**
 * Строки, пришедшие позже панели, раскрываются по высоте, а не толкают вкладки рывком.
 * Были с самого начала (кэш) — показываем сразу, без анимации.
 */
/** unclip — после раскрытия не обрезать содержимое (подсказки над кнопками). */
export function Expand({ show, unclip, children }: { show: boolean; unclip?: boolean; children: ComponentChildren }) {
  const [state, setState] = useState<'instant' | 'closed' | 'open'>(show ? 'instant' : 'closed');
  useEffect(() => {
    if (!show) { setState('closed'); return; }
    if (state !== 'closed') return;
    const id = requestAnimationFrame(() => setState('open'));
    return () => cancelAnimationFrame(id);
  }, [show]);
  return <div class={'app-expand' + (unclip ? ' app-expand-unclip' : '')} data-state={show ? state : 'closed'}><div class="app-expand-inner">{children}</div></div>;
}
