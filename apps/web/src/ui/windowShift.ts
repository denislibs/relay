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
 *  ленты съедала бы кадры анимации. Запоминается одно, последнее направление; после анимации сдвиг сам
 *  перепроверит, нужен ли он ещё. */
export function deferShift(box: { dir: ShiftDir | null }, dir: ShiftDir, heavy: boolean, later: (fn: () => void) => void, run: (dir: ShiftDir) => void): void {
  if (!heavy) { run(dir); return; }
  const had = box.dir;
  box.dir = dir;
  if (!had) later(() => { const d = box.dir; box.dir = null; if (d) run(d); });
}
