/**
 * Удаление с анимацией (как в tweb): удалённая из окна строка ещё один рендер остаётся на своём месте («уходящая»),
 * лента выводит её из потока и соседи доезжают на её место FLIP-переводом (только transform/opacity, §3.5 SMOOTH-UI).
 * Здесь — чистая часть: что считать удалением, как вставить уходящих обратно в список и чему равны сдвиги.
 */
export type Msg = { key: string; sort: number; groupId?: string | null; service?: unknown; deleted?: boolean };

export const LEAVE_MS = 220;        // соседи доезжают, уходящая гаснет
export const LEAVE_HOLD_MS = 240;   // буфер живёт до конца анимации (по таймеру, не по animationend)

/**
 * Удалённые из середины окна: были в прошлом окне, нет в новом, и по sort лежат между соседями нового окна.
 * У живого края (atEnd: окно у последних сообщений) удалённое последнее — тоже удаление, у начала истории
 * (atStart) — первое. Иначе края не считаются: окно сдвинулось или подрезалось. Смена окна целиком (нет общих
 * ключей), фото живого альбома (альбом перерисуется на месте) и служебные строки — не анимируются.
 */
export function interiorRemovals<M extends Msg>(prev: readonly M[] | null, next: readonly M[], edges: { atStart?: boolean; atEnd?: boolean } = {}): M[] {
  if (!prev || !prev.length || !next.length) return [];
  const keys = new Set(next.map((m) => m.key));
  if (!prev.some((m) => keys.has(m.key))) return [];
  const lo = next[0].sort, hi = next[next.length - 1].sort;
  const groups = new Set<string>();
  for (const m of next) if (m.groupId) groups.add(m.groupId);
  const out: M[] = [];
  for (const m of prev) {
    if (keys.has(m.key) || m.service || m.deleted) continue;
    if (!edges.atStart && m.sort <= lo) continue;
    if (!edges.atEnd && m.sort >= hi) continue;
    if (m.groupId && groups.has(m.groupId)) continue;
    out.push(m);
  }
  return out;
}

/** Уходящие — обратно в список на свои места (оба отсортированы по sort). */
export function mergeLeaving<M extends Msg>(next: readonly M[], leaving: Iterable<M>): M[] {
  const keys = new Set(next.map((m) => m.key));
  const extra = [...leaving].filter((m) => !keys.has(m.key)).sort((a, b) => a.sort - b.sort);   // вернулось в окно — не дубль
  if (!extra.length) return next as M[];
  const out: M[] = [];
  let j = 0;
  for (const m of next) {
    while (j < extra.length && extra[j].sort < m.sort) out.push(extra[j++]);
    out.push(m);
  }
  while (j < extra.length) out.push(extra[j++]);
  return out;
}

/** Сдвиги строк между двумя раскладками: было − стало (translateY, с которого строка едет к нулю). */
export function flipDeltas(first: Map<string, number>, last: Map<string, number>): [string, number][] {
  const out: [string, number][] = [];
  for (const [key, top] of last) {
    const was = first.get(key);
    if (was !== undefined && Math.abs(was - top) > 1) out.push([key, was - top]);
  }
  return out;
}
