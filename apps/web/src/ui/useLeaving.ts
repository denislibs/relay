import { useEffect, useRef, useState } from 'preact/hooks';

export interface Row<T> { item: T; key: string; leaving: boolean }
/** Ушедшая строка и её сосед сверху в прежнем списке (null — была первой). */
export type Leaving<T> = Map<string, { item: T; after: string | null }>;

/**
 * Список для отрисовки: текущие строки + ушедшие, которые ещё доигрывают выход, на прежних местах.
 * Ушедшая встаёт сразу за своим прежним соседом сверху; был первым — в начало; сосед тоже пропал — в конец.
 * leaving меняется на месте: новые ушедшие добавляются, вернувшиеся — убираются.
 */
export function mergeLeaving<T>(prev: readonly { item: T; key: string }[], items: readonly T[], key: (t: T) => string, leaving: Leaving<T>, animate = true): Row<T>[] {
  const keys = new Set(items.map(key));
  prev.forEach((p, i) => {
    if (animate && !keys.has(p.key) && !leaving.has(p.key)) leaving.set(p.key, { item: p.item, after: i > 0 ? prev[i - 1].key : null });
  });
  for (const k of [...leaving.keys()]) if (keys.has(k)) leaving.delete(k);
  const out: Row<T>[] = items.map((item) => ({ item, key: key(item), leaving: false }));
  for (const [k, v] of leaving) {
    let at: number;
    if (v.after == null) at = 0;
    else {
      const i = out.findIndex((o) => o.key === v.after);
      at = i >= 0 ? i + 1 : out.length;
    }
    out.splice(at, 0, { item: v.item, key: k, leaving: true });
  }
  return out;
}

/** Строки, ушедшие из списка, ещё ms держатся на месте (класс выхода: схлопывание по высоте), а не пропадают рывком. */
export function useLeaving<T>(items: T[], key: (t: T) => string, ms: number): Row<T>[] {
  const prev = useRef<{ item: T; key: string }[]>([]);
  const leaving = useRef<Leaving<T>>(new Map());
  const [, force] = useState(0);
  const out = mergeLeaving(prev.current, items, key, leaving.current, ms > 0);
  prev.current = out.filter((o) => !o.leaving).map(({ item, key }) => ({ item, key }));
  const n = leaving.current.size;
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => { leaving.current.clear(); force((x) => x + 1); }, ms);
    return () => clearTimeout(t);
  }, [n]);
  return out;
}
