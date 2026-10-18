// «Папка с чатами»: папка всплывает, приоткрывается, из неё выпрыгивают три пузыря-чата и
// раскладываются веером; передняя стенка захлопывается с отскоком, пузыри слегка покачиваются.
import { doc, ease, ellipse, fill, group, layer, nul, poly, rect, type Key } from './lottie';

const BACK = '#E9A23B', TAB = '#E39530', FRONT = '#FFC24B', FRONT_HI = '#FFD677';
const GREEN = '#25D366', WHITE = '#FFFFFF', LINE_W = '#E7F8EE';

export function folder() {
  const root = nul('root', {
    p: [256, 300, 0], a: [256, 300, 0],
    s: [[0, [62, 62, 100], ease.out], [16, [106, 106, 100], ease.inOut], [28, [98, 98, 100], ease.inOut], [38, [100, 100, 100]]] as Key[],
  });
  const parent = { parent: root.ind };

  // задняя стенка с ярлычком
  const back = layer('back', [
    group([rect([300, 210], null, 30, [256, 318]), fill(BACK)]),
    group([rect([130, 60], null, 22, [178, 210]), fill(TAB)]),
  ], { p: [0, 0, 0] }, parent);

  // пузырь-чат: аватар и две строки текста. В группе Lottie первый элемент — сверху, поэтому
  // строки и аватар идут раньше карточки
  const bubble = (nm: string, color: string, line: string, avatar: string, end: [number, number], rot: number, delay: number) => {
    const t0 = 24 + delay, t1 = t0 + 24;
    const bob: Key[] = [[t1 + 8, [end[0], end[1]], ease.inOut], [t1 + 44, [end[0], end[1] - 6], ease.inOut], [t1 + 80, [end[0], end[1]]]];
    return layer(nm, [
      group([
        group([ellipse(30, [-34, 0]), fill(avatar)]),
        group([rect([50, 11], null, 5.5, [16, -9]), fill(line)]),
        group([rect([34, 11], null, 5.5, [8, 10]), fill(line)]),
        group([poly([[-50, 26], [-66, 48], [-28, 38]]), fill(color)]),
        group([rect([124, 80], null, 26, [0, 0]), fill(color)]),
      ]),
    ], {
      p: [[0, [256, 360]], [t0, [256, 360], ease.out], [t1, end, ease.out], ...bob] as Key[],
      s: [[t0, [50, 50], ease.out], [t1 - 8, [105, 105], ease.inOut], [t1 + 4, [100, 100]]] as Key[],
      r: [[t0, 0, ease.out], [t1, rot]] as Key[],
      o: [[t0, 0, ease.lin], [t0 + 6, 100]] as Key[],
    }, parent);
  };
  const left = bubble('left', WHITE, '#D5DCE3', '#6EB7F5', [168, 190], -16, 0);
  const right = bubble('right', WHITE, '#D5DCE3', '#F59AB8', [344, 196], 14, 8);
  const mid = bubble('mid', GREEN, LINE_W, '#FFFFFF', [256, 150], -3, 16);

  // передняя стенка: «открывается» (сжимается к низу), потом захлопывается с отскоком
  const front = layer('front', [
    group([rect([284, 10], null, 5, [256, 250]), fill(FRONT_HI)]),
    group([rect([324, 188], null, 30, [256, 334]), fill(FRONT)]),
  ], {
    a: [256, 428, 0], p: [256, 428, 0],
    s: [[14, [100, 100, 100], ease.out], [30, [100, 74, 100], ease.inOut], [64, [100, 74, 100], ease.out], [78, [100, 104, 100], ease.inOut], [90, [100, 100, 100]]] as Key[],
  }, parent);

  // искорки после приземления
  const spark = (nm: string, p: [number, number], at: number, d: number) =>
    layer(nm, [group([poly([[0, -d], [d * 0.28, -d * 0.28], [d, 0], [d * 0.28, d * 0.28], [0, d], [-d * 0.28, d * 0.28], [-d, 0], [-d * 0.28, -d * 0.28]]), fill('#FFD54A')])], {
      p: [p[0], p[1], 0],
      s: [[at, [0, 0, 100], ease.out], [at + 12, [110, 110, 100], ease.inOut], [at + 30, [0, 0, 100]]] as Key[],
      r: [[at, 0, ease.lin], [at + 30, 90]] as Key[],
    }, parent);

  const shadow = layer('shadow', [group([ellipse(1, [0, 0]), fill('#000000', 10)], { s: [300, 34] })], {
    p: [256, 440, 0],
  }, parent);

  return doc('folder', 180, [
    spark('spark1', [398, 118], 70, 22), spark('spark2', [118, 128], 80, 16), spark('spark3', [352, 74], 92, 12),
    front, mid, right, left, back, shadow, root,
  ]);
}
