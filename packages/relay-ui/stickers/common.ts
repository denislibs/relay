// Общие детали стикеров: искорка и «всплытие» всего стикера при появлении.
import { ease, fill, group, layer, nul, poly, type Key } from './lottie';

export function popRoot(p: [number, number] = [256, 280]) {
  return nul('root', {
    p: [p[0], p[1], 0], a: [p[0], p[1], 0],
    s: [[0, [62, 62, 100], ease.out], [16, [106, 106, 100], ease.inOut], [28, [98, 98, 100], ease.inOut], [38, [100, 100, 100]]] as Key[],
  });
}

export function spark(nm: string, p: [number, number], t: number, d: number, parent: number, color = '#FFD54A') {
  const k = d * 0.28;
  return layer(nm, [group([poly([[0, -d], [k, -k], [d, 0], [k, k], [0, d], [-k, k], [-d, 0], [-k, -k]]), fill(color)])], {
    p: [p[0], p[1], 0],
    s: [[t, [0, 0, 100], ease.out], [t + 12, [110, 110, 100], ease.inOut], [t + 30, [0, 0, 100]]] as Key[],
    r: [[t, 0, ease.lin], [t + 30, 90]] as Key[],
  }, { parent });
}
