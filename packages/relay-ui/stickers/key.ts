// «Ключи доступа»: золотой ключ влетает с поворотом, садится с отскоком и «поворачивается в замке»
// (сжатие по ширине туда-обратно), потом вспыхивают искорки.
import { popRoot, spark } from './common';
import { doc, ease, ellipse, fill, group, layer, rect, type Key } from './lottie';

const GOLD = '#FFC24B', GOLD_DARK = '#E9A23B', SHINE = '#FFE08A';

export function key() {
  const root = popRoot();
  const parent = { parent: root.ind };
  const k = layer('key', [
    // блик на кольце — сверху
    // поворот группы — вокруг её начала координат, поэтому место задаём позицией группы, а не прямоугольника
    group([rect([34, 11], null, 5.5), fill(SHINE)], { p: [-146, -36], r: -55 }),
    // кольцо: два круга с evenodd — отверстие прозрачное
    group([ellipse(150, [-110, 0]), ellipse(64, [-110, 0]), fill(GOLD, 100, true)]),
    // стержень и бородка
    group([rect([210, 40], null, 14, [60, 0]), fill(GOLD)]),
    group([rect([30, 56], null, 8, [118, 32]), fill(GOLD_DARK)]),
    group([rect([24, 40], null, 8, [72, 24]), fill(GOLD_DARK)]),
  ], {
    p: [[0, [242, 290], ease.out], [26, [262, 258], ease.inOut], [40, [262, 266], ease.inOut], [50, [262, 260]]] as Key[],
    r: [[0, -50, ease.out], [26, -32], [70, -32, ease.inOut], [90, -32]] as Key[],
    s: [[50, [100, 100], ease.inOut], [64, [32, 100], ease.inOut], [78, [100, 100]]] as Key[],
  }, parent);
  return doc('key', 150, [
    spark('s1', [380, 150], 80, 22, root.ind), spark('s2', [140, 140], 88, 16, root.ind), spark('s3', [400, 330], 96, 12, root.ind),
    k, root,
  ]);
}
