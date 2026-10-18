// «День рождения»: двухъярусный торт с глазурью и посыпкой всплывает, свечка вырастает и загорается —
// огонёк покачивается, вспыхивают искорки.
import { popRoot, spark } from './common';
import { doc, ease, ellipse, fill, group, layer, rect, type Key } from './lottie';

const SPONGE = '#F9DDB0', SPONGE_SHADE = '#EFC88C', ICING = '#FF8FB1', PLATE = '#DCE2E8', PLATE_SHADE = '#C7CED6',
  CANDLE = '#4FA3F7', STRIPE = '#FFFFFF', FLAME = '#FFB238', FLAME_CORE = '#FFF1B8';
const SPRINKLES = ['#4FA3F7', '#25D366', '#FFC24B', '#B57BFF', '#FFFFFF'];

/** ярус: бисквит, тень снизу, глазурь шапкой с подтёками и посыпка (в Lottie первая фигура — верхняя, поэтому разворачиваем) */
function tier(w: number, h: number, y: number, drips: [number, number][], dots: [number, number][]) {
  return ([
    group([rect([w, h], null, 22, [0, y]), fill(SPONGE)]),
    group([rect([w, 16], null, 8, [0, y + h / 2 - 12]), fill(SPONGE_SHADE)]),
    group([rect([w + 12, 46], null, 23, [0, y - h / 2 + 16]), ...drips.map(([x, d]) => ellipse(d, [x, y - h / 2 + 34])), fill(ICING)]),
    group([rect([w - 30, 8], null, 4, [0, y - h / 2 + 2]), fill('#FFFFFF', 45)]),   // блик на глазури
    ...dots.map(([x, yy], i) => group([rect([14, 6], null, 3, [0, 0]), fill(SPRINKLES[i % SPRINKLES.length])], { p: [x, y - h / 2 + yy], r: (i * 47) % 180 - 90 })),
  ] as object[]).reverse();
}

export function cake() {
  const root = popRoot([256, 300]);
  const parent = { parent: root.ind };
  const body = layer('body', [
    // сверху вниз: верхний ярус, нижний, тарелка
    ...tier(240, 110, -42, [[-90, 40], [-20, 32], [52, 42], [100, 30]], [[-70, 12], [10, 6], [80, 14]]),
    ...tier(360, 150, 82, [[-140, 46], [-70, 36], [6, 50], [86, 38], [148, 42]], [[-120, 10], [-40, 18], [40, 8], [120, 16]]),
    group([rect([420, 30], null, 15, [0, 160]), fill(PLATE)]),
    group([rect([420, 40], null, 20, [0, 168]), fill(PLATE_SHADE)]),
  ], { p: [256, 300, 0] }, parent);
  const candle = layer('candle', [
    group([rect([30, 12], null, 0, [0, -26]), rect([30, 12], null, 0, [0, 10]), rect([30, 12], null, 0, [0, 44]), fill(STRIPE, 85)]),   // полоски — ровные, за края свечки не выходят
    group([rect([30, 110], null, 10, [0, 0]), fill(CANDLE)]),
  ], {
    p: [256, 202, 0], a: [0, 55, 0],
    s: [[10, [100, 0, 100], ease.out], [26, [100, 110, 100], ease.inOut], [34, [100, 100, 100]]] as Key[],   // вырастает из торта
  }, parent);
  // огонёк: загорается после свечки и мягко покачивается (вытягивается и наклоняется)
  const flicker: Key[] = [[34, [0, 0, 100], ease.out], [46, [112, 122, 100], ease.inOut]];
  const sway: Key[] = [];
  for (let f = 46, i = 0; f < 150; f += 14, i++) {
    flicker.push([f + 7, i % 2 ? [104, 112, 100] : [94, 128, 100], ease.inOut]);
    sway.push([f, i % 2 ? -7 : 7, ease.inOut]);
  }
  flicker.push([150, [100, 118, 100]]);
  sway.push([150, 0]);
  const flame = layer('flame', [
    group([ellipse(26, [0, 8]), fill(FLAME_CORE)], { s: [80, 120] }),
    group([ellipse(56, [0, 0]), fill(FLAME)], { s: [78, 132] }),
  ], { p: [256, 126, 0], a: [0, 30, 0], s: flicker, r: sway }, parent);
  return doc('cake', 150, [
    spark('s1', [110, 150], 50, 22, root.ind, '#FF8FB1'), spark('s2', [404, 130], 58, 18, root.ind), spark('s3', [420, 300], 70, 14, root.ind, '#4FA3F7'),
    spark('s4', [92, 300], 78, 12, root.ind, '#25D366'),
    flame, candle, body, root,
  ]);
}
