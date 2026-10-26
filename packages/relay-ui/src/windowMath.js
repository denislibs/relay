/* Чистая геометрия виртуальных списков (more.js: WindowGrid). */

/** Сетка cols квадратов через gap по ширине width — в целых пикселях (дробные дают «швы» между плитками):
 *  остаток ширины раздаётся по пикселю первым колонкам. cell — высота плитки, step — шаг строки (с зазором). */
export function gridLayout(width, cols, gap) {
  var W = Math.floor(width), avail = W - gap * (cols - 1);
  var base = avail > 0 ? Math.floor(avail / cols) : 0;
  if (base <= 0) return { cell: 0, step: 0, cols: [] };
  var rem = avail - base * cols, out = [], x = 0;
  for (var c = 0; c < cols; c++) {
    var w = base + (c < rem ? 1 : 0);
    out.push({ x: x, w: w });
    x += w + gap;
  }
  return { cell: base, step: base + gap, cols: out };
}

/** Строка, в которую попадает смещение px, когда у строк разная высота: tops — верхи строк и в конце полная
 *  высота (tops.length = строк + 1). Последняя строка, чей верх не ниже px; выше начала — 0, ниже конца — последняя. */
export function rowAt(tops, px) {
  var lo = 0, hi = tops.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tops[mid] <= px) lo = mid; else hi = mid - 1; }
  return lo;
}
