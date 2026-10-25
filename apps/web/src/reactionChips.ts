// Группировка реакций сообщения в плашки — чистая функция (тесты без ленты).
import { emojiKey } from '@relay/protocol';

export type Chip = {
  key: string;            // эмодзи без FE0F — «❤️» и «❤» одна плашка
  emoji: string;          // как прислал первый поставивший (для aria и отправки)
  count: number;
  mine: boolean;
  icon?: string;          // картинка из каталога (нет — глиф)
  who?: number[];         // кто поставил, пока реакций на сообщении меньше четырёх (вместо числа — аватары)
  users?: { name: string; src?: string; thumb?: string; tone?: number }[];
};

type Msg = { reactions?: { userId: number; emoji: string }[]; reactionCounts?: [string, number][]; myReaction?: string };

/** Пост канала — счётчиками (reactionCounts, списка реакторов нет), иначе по списку «кто что поставил» в порядке
 *  первого появления (на сервере — по времени). */
export function groupReactions(m: Msg, meId: number): Chip[] {
  const chips: Chip[] = [];
  if (m.reactionCounts) {
    const mineKey = m.myReaction ? emojiKey(m.myReaction) : null;
    for (const [emoji, count] of m.reactionCounts) { const key = emojiKey(emoji); chips.push({ key, emoji, count, mine: mineKey === key }); }
    return chips;
  }
  const list = m.reactions ?? [];
  for (const r of list) {
    const key = emojiKey(r.emoji);
    const c = chips.find((x) => x.key === key);
    if (c) { c.count++; c.mine ||= r.userId === meId; c.who!.push(r.userId); } else chips.push({ key, emoji: r.emoji, count: 1, mine: r.userId === meId, who: [r.userId] });
  }
  if (list.length >= 4) for (const c of chips) delete c.who;
  return chips;
}
