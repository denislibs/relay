// Разделы, не нужные первому экрану (вход, настройки, стикеры, группы), — отдельными чанками сборки (build.ts:
// splitting): основной бандл меньше, его разбор и выполнение при загрузке короче. Чанк грузится при первом показе
// раздела или заранее, в простое после старта (preloadLazy) — тогда к первому открытию он уже здесь. Офлайн его отдаёт
// Service Worker: все чанки сборки — в оболочке (build.ts → sw.ts).
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

type Loader<P> = () => Promise<ComponentType<P>>;
type Lazy<P> = ComponentType<P> & { preload(): Promise<unknown> };

const all: Array<() => Promise<unknown>> = [];

/**
 * Компонент из чанка. До загрузки — ничего (из кэша SW это кадр-два; разделы, открытые из меню, к тому времени уже
 * загружены в простое). Ошибка загрузки (сборку сменили, старого чанка нет) — повтор при следующем показе.
 */
export function lazy<P>(load: Loader<P>, idle = true): Lazy<P> {
  let comp: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => (pending ??= load().then((c) => (comp = c), (e) => { pending = null; throw e; }));
  function Lazy(props: P) {
    const [, ready] = useState(0);
    const C = comp;
    // по тому, что отрисовано: чанк мог догрузиться между отрисовкой (null) и эффектом (предзагрузка) — тогда
    // проверка comp в эффекте уже видит его и перерисовку не заказывает, и раздел так и остаётся пустым
    useEffect(() => { if (!C) get().then(() => ready(1), () => {}); }, []);
    return C ? <C {...(props as P & object)} /> : null;
  }
  const out = Lazy as unknown as Lazy<P>;
  out.preload = () => get().catch(() => {});
  if (idle) all.push(out.preload);   // idle = false — только по показу (вход: вошедшему не нужен)
  return out;
}

/**
 * Догрузить ленивые разделы после первого экрана — по одному, каждый в своём простое (idle): разбор и выполнение
 * всех чанков разом сами стали бы долгой задачей. Уже загруженные (раздел успели открыть) проходят сразу.
 */
export function preloadLazy(idle: (fn: () => void) => void): void {
  const next = (i: number) => { if (i < all.length) idle(() => { void all[i]().then(() => next(i + 1)); }); };
  next(0);
}
