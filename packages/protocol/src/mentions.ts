// Упоминания @username (как в Telegram): разбор одинаковый у сервера (кому писать mention) и клиента (подсветка).
import type { Block } from './blocks';
import type { Entity } from './index';

/** Имя пользователя: латиница, цифры и «_», с буквы, 5–32 знака (хранится в нижнем регистре). */
export const USERNAME_MIN = 5, USERNAME_MAX = 32;
export const USERNAME = new RegExp(`^[a-z][a-z0-9_]{${USERNAME_MIN - 1},${USERNAME_MAX - 1}}$`);

/**
 * @имя в тексте: слева не буква/цифра/«_», не «@» и не «./» (medium.com/@name, a@b.com — не упоминания), справа —
 * не продолжение слова (имя длиннее USERNAME_MAX — не упоминание). Регистр не важен: в группе 1 — имя.
 */
export const MENTION_RE = new RegExp(`(?<![\\p{L}\\p{N}_@./])@([A-Za-z][A-Za-z0-9_]{${USERNAME_MIN - 1},${USERNAME_MAX - 1}})(?![\\p{L}\\p{N}_])`, 'gu');

/** Оформление, внутри которого @имя — не упоминание: код, блок кода, ссылка. */
const SKIP = new Set<Entity['type']>(['code', 'pre', 'link']);

function scan(text: string, entities: readonly Entity[] | undefined, out: Set<string>): void {
  const skip = (entities ?? []).filter((e) => SKIP.has(e.type));
  for (const m of text.matchAll(MENTION_RE)) {
    const at = m.index!, end = at + m[0].length;
    if (skip.some((e) => at < e.offset + e.length && end > e.offset)) continue;   // задевает код или ссылку
    out.add(m[1].toLowerCase());
  }
}

/**
 * Упомянутые имена (нижний регистр, по порядку появления, без повторов) — вне code/pre/link. Статья — по блокам:
 * абзацы, заголовки, списки, цитаты; блоки кода пропускаются.
 */
export function mentionsIn(text: string, entities?: readonly Entity[] | null, blocks?: readonly Block[] | null): string[] {
  const out = new Set<string>();
  if (blocks?.length) {
    const walk = (list: readonly Block[]) => {
      for (const b of list) {
        if (b.type === 'p' || b.type === 'h') scan(b.text, b.entities, out);
        else if (b.type === 'quote') walk(b.blocks);
        else if (b.type === 'ul' || b.type === 'ol') for (const it of b.items) walk(it);
      }
    };
    walk(blocks);
  } else scan(text, entities ?? [], out);
  return [...out];
}
