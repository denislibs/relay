// Каркас приложения (public/shell.html → index.html) — копия первого кадра боковой колонки. Здесь (только dev):
//   • shellSignature — структура (теги и классы) без того, что в каркас не входит: плашки-подсказки, вуаль скрытия
//     экрана, классы появления, слои обоев, скелетон; main.tsx сравнивает каркас с первым кадром приложения и пишет
//     в консоль [shell], если шапку или колонку поменяли, а каркас — нет;
//   • snapshotShell — готовая разметка для public/shell.html из первого кадра приложения: в консоли dev-сборки
//     copy(__relayShellSnapshot()) и вставить в файл (одной строкой).

const DROP = '.rl-shell-veil, .rl-sidecard-over > .rl-presence, .app-banner-slot, .app-listwrap > *, :scope > [hidden]';
const VOLATILE = /^(app-enter-\w+|tw-wrap|is-fresh|app-skel-instant)$/;

/** Теги и классы по порядку обхода, без изменчивого. */
export function shellSignature(shell: Element): string[] {
  const out: string[] = [];
  const skip = new Set(shell.querySelectorAll(DROP));
  const walk = (el: Element, depth: number): void => {
    if (skip.has(el)) return;
    const cls = [...el.classList].filter((c) => !VOLATILE.test(c)).sort().join('.');
    out.push(depth + ':' + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (el.getAttribute('data-icon') ? '#' + el.getAttribute('data-icon') : ''));
    if (el.tagName === 'svg' || el.classList.contains('rl-tw')) return;   // иконку сравниваем по имени, слои обоев — свои
    for (const ch of el.children) walk(ch, depth + 1);
  };
  walk(shell, 0);
  return out;
}

/** Первое расхождение двух структур или null. */
export function shellDiff(a: string[], b: string[]): { at: number; shell?: string; app?: string } | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return { at: i, shell: a[i], app: b[i] };
  return null;
}

const SKEL_ROW = (i: number) => `<div style="--i: ${i};"><div class="rl-skel" aria-hidden="true"><i style="width: 54px; height: 54px;"></i><span style="flex: 1 1 0%; display: flex; flex-direction: column; gap: 8px;"><i style="width: 55%; height: 12px;"></i><i style="width: 80%; height: 10px;"></i></span></div></div>`;
const SKEL = `<div data-state="open" class="rl-presence"><div class="app-skel app-skel-instant" aria-busy="true" aria-label="Загрузка чатов">${Array.from({ length: 9 }, (_, i) => SKEL_ROW(i)).join('')}</div></div>`;

/** Разметка public/shell.html из первого кадра приложения (#app > .rl-shell). */
export function snapshotShell(appShell: Element): string {
  const c = appShell.cloneNode(true) as Element;
  for (const el of c.querySelectorAll(DROP)) el.remove();
  for (const el of [c, ...c.querySelectorAll('[class]')]) for (const k of [...el.classList]) if (/^app-enter-/.test(k)) el.classList.remove(k);
  for (const el of c.querySelectorAll('[id], [for]')) { el.removeAttribute('id'); el.removeAttribute('for'); }
  // переменные, которые приложение мерит на ходу (--over-h — высота плашки-подсказки и т. п.), в каркас не идут
  for (const el of c.querySelectorAll<HTMLElement>('[style]')) {
    for (const p of [...el.style]) if (p.startsWith('--')) el.style.removeProperty(p);
    if (!el.getAttribute('style')) el.removeAttribute('style');
  }
  const tw = c.querySelector('.rl-tw');
  if (tw) { tw.classList.add('tw-wrap'); tw.removeAttribute('style'); tw.innerHTML = '<div class="tw-canvas"></div><div class="tw-pattern"></div>'; }
  const list = c.querySelector('.app-listwrap');
  if (list) { list.className = 'app-listwrap'; list.innerHTML = SKEL; }
  return c.outerHTML.replace(/>\s+</g, '><').replace(/\n\s*/g, '');
}
