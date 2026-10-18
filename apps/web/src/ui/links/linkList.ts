import { MAX_LINKS, type ProfileLink } from '@relay/protocol';

/** Чистые операции над списком ссылок (порядок — как у владельца). */
export const sameLink = (a: ProfileLink, b: ProfileLink) => a.service === b.service && a.handle.toLowerCase() === b.handle.toLowerCase();

export function moveLink(list: ProfileLink[], from: number, to: number): ProfileLink[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

/** Сохранить ссылку: новая — в конец, правка — на своё место; такая же уже есть — повтор не заводим. */
export function putLink(list: ProfileLink[], at: number | null, link: ProfileLink): ProfileLink[] {
  const rest = list.filter((l, i) => i !== at && !sameLink(l, link));
  if (at === null) return rest.length >= MAX_LINKS ? rest : [...rest, link];
  const out = list.slice();
  out[at] = link;
  return out.filter((l, i) => i === at || !sameLink(l, link));
}

/** Куда встанет перетаскиваемая строка: сдвиг в строках, округлённый, в пределах списка. */
export function dropIndex(from: number, dy: number, rowH: number, n: number): number {
  return Math.max(0, Math.min(n - 1, from + Math.round(dy / rowH)));
}

/** Сдвиг соседей, пока строка from тащится на место to: они расступаются на одну строку. */
export function shiftFor(i: number, from: number, to: number): -1 | 0 | 1 {
  if (from < to && i > from && i <= to) return -1;
  if (from > to && i >= to && i < from) return 1;
  return 0;
}
