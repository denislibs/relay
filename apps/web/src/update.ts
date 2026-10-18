// «Доступна новая версия»: вкладка сверяет свою сборку с /version.json (его пишет build.ts) —
// при старте и раз в 5 минут, пока окно на экране. Отличается — показываем кнопку «Обновить Relay»,
// а не перезагружаем молча: человек может быть посреди сообщения. Данные старая вкладка не испортит:
// если новая сборка обновит базу, движок сам перезагрузит все вкладки (host-core, obsolete).

export const CHECK_MS = 5 * 60_000;
const FIRST_MS = 10_000;   // первая проверка — когда старт уже позади

export interface UpdateDeps {
  current: string;
  fetchBuild: () => Promise<string | null>;
  onUpdate: (build: string) => void;
  now?: () => number;
  visible?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onVisible?: (fn: () => void) => () => void;
}

/** Запускает проверки; возвращает stop. Нашли новую сборку — сообщаем один раз и больше не спрашиваем. */
export function startUpdateCheck(d: UpdateDeps): () => void {
  const now = d.now ?? (() => Date.now());
  const visible = d.visible ?? (() => document.visibilityState === 'visible');
  const setT = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let last = 0, timer: unknown = null, done = false, busy = false;

  const check = async () => {
    if (done || busy) return;
    busy = true;
    last = now();
    try {
      const b = await d.fetchBuild();
      if (!done && b && b !== d.current) { done = true; d.onUpdate(b); }
    } catch { /* нет сети — спросим в следующий раз */ }
    busy = false;
  };
  const schedule = (ms: number) => {
    timer = setT(() => { if (visible()) void check(); if (!done) schedule(CHECK_MS); }, ms);
  };
  schedule(FIRST_MS);
  // вкладка долго лежала в фоне — вернулись к ней, проверяем сразу
  const off = d.onVisible?.(() => { if (!done && now() - last >= CHECK_MS) void check(); }) ?? (() => {});
  return () => { done = true; if (timer != null) clearT(timer); off(); };
}

export async function fetchBuild(): Promise<string | null> {
  const res = await fetch('/version.json', { cache: 'no-store' });
  if (!res.ok) return null;
  const j = (await res.json()) as { build?: unknown };
  return typeof j.build === 'string' ? j.build : null;
}

export function onVisible(fn: () => void): () => void {
  const h = () => { if (document.visibilityState === 'visible') fn(); };
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
}
