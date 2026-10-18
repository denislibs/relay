// «Ссылки»: два звена цепи въезжают с боков, сцепляются с отскоком, вспыхивают искорки.
import { popRoot, spark } from './common';
import { doc, ease, fill, group, layer, rect, type Key } from './lottie';

const BLUE = '#4FA3F7', GREEN = '#25D366';

// звено — скруглённый прямоугольник-рамка: внешний и внутренний контуры с evenodd
const linkShape = (color: string) => group([rect([220, 120], null, 60), rect([150, 52], null, 26), fill(color, 100, true)], { r: -40 });

export function link() {
  const root = popRoot([256, 256]);
  const parent = { parent: root.ind };
  const a = layer('a', [linkShape(BLUE)], {
    p: [[0, [140, 330], ease.out], [30, [214, 296], ease.inOut], [40, [206, 302], ease.inOut], [50, [210, 298]]] as Key[],
  }, parent);
  const b = layer('b', [linkShape(GREEN)], {
    p: [[0, [372, 182], ease.out], [30, [298, 216], ease.inOut], [40, [306, 210], ease.inOut], [50, [302, 214]]] as Key[],
  }, parent);
  return doc('link', 150, [
    spark('s1', [256, 120], 44, 22, root.ind), spark('s2', [400, 330], 52, 16, root.ind), spark('s3', [110, 180], 58, 12, root.ind),
    b, a, root,
  ]);
}
