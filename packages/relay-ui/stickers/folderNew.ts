// «Новая папка»: папка всплывает и приоткрывается, на угол передней стенки с отскоком садится
// зелёный значок «+», «+» прокручивается, вокруг вспыхивают искорки.
import { doc, ease, ellipse, fill, group, layer, nul, poly, rect, type Key } from './lottie';

const BACK = '#E9A23B', TAB = '#E39530', FRONT = '#FFC24B', FRONT_HI = '#FFD677', GREEN = '#25D366';

export function folderNew() {
  const root = nul('root', {
    p: [256, 300, 0], a: [256, 300, 0],
    s: [[0, [62, 62, 100], ease.out], [16, [106, 106, 100], ease.inOut], [28, [98, 98, 100], ease.inOut], [38, [100, 100, 100]]] as Key[],
  });
  const parent = { parent: root.ind };

  const back = layer('back', [
    group([rect([300, 210], null, 30, [256, 318]), fill(BACK)]),
    group([rect([130, 60], null, 22, [178, 210]), fill(TAB)]),
  ], { p: [0, 0, 0] }, parent);
  const front = layer('front', [
    group([rect([284, 10], null, 5, [256, 250]), fill(FRONT_HI)]),
    group([rect([324, 188], null, 30, [256, 334]), fill(FRONT)]),
  ], {
    a: [256, 428, 0], p: [256, 428, 0],
    s: [[12, [100, 100, 100], ease.out], [24, [100, 88, 100], ease.inOut], [36, [100, 103, 100], ease.inOut], [46, [100, 100, 100]]] as Key[],
  }, parent);
  const shadow = layer('shadow', [group([ellipse(1), fill('#000000', 10)], { s: [300, 34] })], { p: [256, 440, 0] }, parent);

  // значок «+»: прилетает сверху справа, садится с отскоком, плюс делает пол-оборота
  const at = 30;
  const plus = layer('plus', [
    group([rect([16, 64], null, 8), fill('#FFFFFF')], { r: [[at + 10, -90, ease.out], [at + 34, 0]] as Key[] }),
    group([rect([64, 16], null, 8), fill('#FFFFFF')], { r: [[at + 10, -90, ease.out], [at + 34, 0]] as Key[] }),
    group([ellipse(124), fill(GREEN)]),
    group([ellipse(140), fill('#FFFFFF')]),
  ], {
    p: [[at, [420, 150], ease.out], [at + 18, [372, 360], ease.inOut], [at + 26, [372, 348], ease.inOut], [at + 34, [372, 356]]] as Key[],
    s: [[at, [30, 30], ease.out], [at + 18, [112, 92], ease.inOut], [at + 26, [94, 106], ease.inOut], [at + 36, [100, 100]]] as Key[],
    o: [[at, 0, ease.lin], [at + 6, 100]] as Key[],
  }, parent);

  const spark = (nm: string, p: [number, number], t: number, d: number) =>
    layer(nm, [group([poly([[0, -d], [d * 0.28, -d * 0.28], [d, 0], [d * 0.28, d * 0.28], [0, d], [-d * 0.28, d * 0.28], [-d, 0], [-d * 0.28, -d * 0.28]]), fill('#FFD54A')])], {
      p: [p[0], p[1], 0],
      s: [[t, [0, 0, 100], ease.out], [t + 12, [110, 110, 100], ease.inOut], [t + 30, [0, 0, 100]]] as Key[],
      r: [[t, 0, ease.lin], [t + 30, 90]] as Key[],
    }, parent);

  return doc('folderNew', 150, [
    spark('s1', [460, 270], at + 26, 20), spark('s2', [300, 250], at + 34, 14), spark('s3', [462, 420], at + 40, 12),
    plus, front, back, shadow, root,
  ]);
}
