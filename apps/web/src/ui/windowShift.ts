/**
 * Сдвиг окна ленты (Feed): когда двигать, сколько держать якорь и какая строка — якорь после сдвига. Отдельно от
 * компонента — чтобы проверять тестами.
 */
export type ShiftDir = 'older' | 'newer';
type Edges = { hasOlder: boolean; hasNewer: boolean };

/**
 * Двигать ли окно: за этим краем что-то есть и листают туда же (или ещё не листали). Против прокрутки — нет: иначе
 * на коротких сообщениях окно качается — сдвиг к старым оставляет нижний датчик в зоне, он тянет к новым, и так по кругу.
 * Сменили направление — scrollDir уже новый, и сдвиг туда снова можно.
 */
export function shiftWanted(dir: ShiftDir, meta: Edges | null, scrollDir: -1 | 0 | 1): boolean {
  if (!meta || !(dir === 'older' ? meta.hasOlder : meta.hasNewer)) return false;
  return scrollDir !== (dir === 'older' ? 1 : -1);
}

/**
 * Запросить сдвиг: якорь (что было вверху видимой части) — замер до сдвига, держится до прихода нового окна.
 * Сдвиг не запрошен (move вернул false: прежний ещё в пути, за краем уже пусто) — якоря нет: иначе он ждал бы окна,
 * которое не придёт, и следующие сдвиги в обе стороны не начинались бы никогда.
 */
export function requestShift<A>(measure: () => A | null, move: () => boolean): A | null {
  const a = measure();
  return move() ? a : null;
}

type Row = { dataset: { key?: string; sort?: string } };
/**
 * Строка сообщения (key, sort) среди строк ленты (по порядку): по ключу; нет такой — та, что его содержит (последняя
 * с sort не больше). Альбом — одна строка с ключом первого своего фото в окне: окно, разрезавшее альбом иначе, даёт
 * строке другой ключ, и по одному ключу восстановление позиции промахивалось (лента вставала в низ окна), а якорь
 * сдвига терялся (лента прыгала).
 */
export function rowFor<R extends Row>(rows: Iterable<R>, key: string, sort: number): R | null {
  let hit: R | null = null;
  for (const r of rows) {
    if (r.dataset.key === key) return r;
    if (Number(r.dataset.sort) <= sort) hit = r;
  }
  return hit;
}

/** Сдвиг окна во время тяжёлой анимации (переход стека, доезд ленты) откладывается до её конца: перераскладка
 *  ленты съедала бы кадры анимации. Запоминаются оба направления (у короткой ленты оба датчика в кадре сразу);
 *  после анимации каждый сдвиг сам перепроверит, нужен ли он ещё. */
export function deferShift(box: { dirs: Set<ShiftDir> }, dir: ShiftDir, heavy: boolean, later: (fn: () => void) => void, run: (dir: ShiftDir) => void): void {
  if (!heavy) { run(dir); return; }
  const waiting = box.dirs.size > 0;
  box.dirs.add(dir);
  if (!waiting) later(() => { const ds = [...box.dirs]; box.dirs.clear(); for (const d of ds) run(d); });
}

/** Края якорной строки относительно видимой области (0 — её верх). */
export type Edges2 = { top: number; bottom: number };

/**
 * На сколько сдвинуть прокрутку, чтобы якорная строка осталась на месте (как ScrollSaver в Telegram Web K):
 * обычно держим верх; строка торчит только за верхний край — держим её низ (то, что видно); торчит за оба края
 * и стала ниже (свернулась) — подтягиваем её верх к верху экрана, а не к старой координате за экраном.
 */
export function anchorShift(was: Edges2, now: Edges2, viewHeight: number): number {
  const overTop = was.top < 0, overBottom = was.bottom > viewHeight;
  if (overTop && overBottom && now.bottom - now.top < was.bottom - was.top - 1) return now.top;
  if (overTop && !overBottom) return now.bottom - was.bottom;
  return now.top - was.top;
}

/** Порция, пришедшая сдвигом окна: собирается скрытой (Feed), пока не соберётся вся. edge — крайняя прежняя строка
 *  (новые — до неё у сдвига к старым, после — к новым), total — сколько новых, built — сколько уже собрано. */
export type Stage = { dir: ShiftDir; edge: string; sort: number; total: number; built: number; done: boolean };

/**
 * Что пришло сдвигом окна: новые строки с той стороны, куда сдвигали, до первой прежней. Меньше min (или прежних в
 * окне нет вовсе — переход далеко) — null: собирать по частям незачем, окно рисуется сразу, как раньше.
 */
export function stageOf(prev: readonly { key: string }[], next: readonly { key: string; sort?: unknown }[], dir: ShiftDir, min: number): Stage | null {
  const had = new Set(prev.map((x) => x.key));
  let i = -1, total = 0;
  if (dir === 'older') { i = next.findIndex((x) => had.has(x.key)); total = i; }
  else { for (let j = next.length - 1; j >= 0; j--) if (had.has(next[j].key)) { i = j; break; } total = next.length - 1 - i; }
  if (i < 0 || total < min) return null;
  return { dir, edge: next[i].key, sort: Number(next[i].sort), total, built: 0, done: false };
}
