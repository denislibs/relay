// «Статья» — сообщение из блоков (как «богатые» сообщения Telegram): абзацы, заголовки, списки, цитаты, код, разделитель.
// Текст внутри блока — то же оформление, что у обычных сообщений (Entity: жирный, ссылка, спойлер…).
// Если статью можно записать обычным текстом с оформлением (только абзацы и код), она уходит обычным сообщением.
import { normalizeEntities, type Entity } from './index';

export interface InlineText { text: string; entities?: Entity[] }
export type Block =
  | ({ type: 'p' } & InlineText)
  | ({ type: 'h'; level: 1 | 2 | 3 } & InlineText)
  | { type: 'ul'; items: Block[][] }
  | { type: 'ol'; items: Block[][]; start?: number }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'hr' };

/** Пределы статьи: длина текста (UTF-16), число блоков (с пунктами списков), вложенность. */
export const ARTICLE_LIMITS = { length: 32768, blocks: 500, depth: 16 } as const;

const LANG = /^[\w+#.-]{1,24}$/;

/** Проверить и почистить блоки от клиента. null — не статья (не массив, пусто, неизвестный тип, сверх лимитов). */
export function normalizeBlocks(raw: unknown): Block[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const st = { blocks: 0, length: 0 };
  const inline = (o: Record<string, unknown>): InlineText | null => {
    if (typeof o.text !== 'string') return null;
    const text = o.text.replace(/\r\n?/g, '\n');
    st.length += text.length;
    const entities = normalizeEntities(text, o.entities).filter((e) => e.type !== 'pre');   // блок кода — отдельный блок
    return entities.length ? { text, entities } : { text };
  };
  const walk = (list: unknown, depth: number): Block[] | null => {
    if (!Array.isArray(list) || depth > ARTICLE_LIMITS.depth) return null;
    const out: Block[] = [];
    for (const r of list) {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      if (++st.blocks > ARTICLE_LIMITS.blocks) return null;
      switch (o.type) {
        case 'p': { const t = inline(o); if (!t) return null; out.push({ type: 'p', ...t }); break; }
        case 'h': {
          const t = inline(o); if (!t) return null;
          const level = o.level === 1 || o.level === 2 || o.level === 3 ? o.level : 1;
          if (t.text.trim()) out.push({ type: 'h', level, ...t });   // пустой заголовок — не нужен
          break;
        }
        case 'ul': case 'ol': {
          if (!Array.isArray(o.items) || !o.items.length) return null;
          const items: Block[][] = [];
          for (const it of o.items) { const b = walk(it, depth + 1); if (!b) return null; if (b.length) items.push(b); }
          if (!items.length) break;
          if (o.type === 'ol') {
            const start = Number.isSafeInteger(o.start) && (o.start as number) > 1 && (o.start as number) < 1e6 ? o.start as number : undefined;
            out.push(start ? { type: 'ol', items, start } : { type: 'ol', items });
          } else out.push({ type: 'ul', items });
          break;
        }
        case 'quote': { const b = walk(o.blocks, depth + 1); if (!b) return null; if (b.length) out.push({ type: 'quote', blocks: b }); break; }
        case 'code': {
          if (typeof o.text !== 'string') return null;
          st.length += o.text.length;
          out.push(typeof o.lang === 'string' && LANG.test(o.lang) ? { type: 'code', text: o.text, lang: o.lang } : { type: 'code', text: o.text });
          break;
        }
        case 'hr': out.push({ type: 'hr' }); break;
        default: return null;
      }
      if (st.length > ARTICLE_LIMITS.length) return null;
    }
    return out;
  };
  const blocks = walk(raw, 0);
  if (!blocks) return null;
  // пустые абзацы по краям — не нужны
  while (blocks.length && blocks[0].type === 'p' && !blocks[0].text.trim()) blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].type === 'p' && !(blocks[blocks.length - 1] as InlineText).text.trim()) blocks.pop();
  return blocks.length ? blocks : null;
}

/** Простой текст статьи — для превью в списке чатов, поиска и уведомлений. */
export function blocksText(blocks: Block[]): string {
  const lines: string[] = [];
  const walk = (list: Block[], indent: string) => {
    for (const b of list) {
      switch (b.type) {
        case 'p': case 'h': lines.push(indent + b.text); break;
        case 'code': lines.push(b.text); break;
        case 'hr': lines.push('———'); break;
        case 'quote': walk(b.blocks, indent); break;
        case 'ul': case 'ol': b.items.forEach((it, i) => {
          const mark = b.type === 'ol' ? `${(b.start ?? 1) + i}. ` : '• ';
          const sub: string[] = []; const save = lines.length;
          walk(it, indent + '  ');
          const got = lines.splice(save).map((l) => l.trimStart());
          sub.push(...got);
          if (sub.length) { lines.push(indent + mark + sub[0]); for (const l of sub.slice(1)) lines.push(indent + '  ' + l); }
        }); break;
      }
    }
  };
  walk(blocks, '');
  return lines.join('\n').trim();
}

/** Статья как обычный текст с оформлением — если в ней только абзацы и код (иначе null: нужна статья). */
export function blocksToText(blocks: Block[]): { text: string; entities: Entity[] } | null {
  let text = '';
  const entities: Entity[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i) text += '\n';
    if (b.type === 'p') {
      for (const e of b.entities ?? []) entities.push({ ...e, offset: e.offset + text.length });
      text += b.text;
    } else if (b.type === 'code') {
      if (b.text) entities.push({ type: 'pre', offset: text.length, length: b.text.length });
      text += b.text;
    } else return null;
  }
  return { text, entities };
}

/** Текст с оформлением → блоки (абзац на строку; блоки кода — из pre). Для разворота поля ввода в редактор статьи. */
export function textToBlocks(text: string, entities: Entity[] = []): Block[] {
  const blocks: Block[] = [];
  const pres = entities.filter((e) => e.type === 'pre').sort((a, b) => a.offset - b.offset);
  const rest = entities.filter((e) => e.type !== 'pre');
  const para = (from: number, to: number) => {
    let at = from;
    for (const line of text.slice(from, to).split('\n')) {
      const start = at, end = at + line.length;
      const ents = rest.filter((e) => e.offset < end && e.offset + e.length > start)
        .map((e) => { const s = Math.max(e.offset, start), f = Math.min(e.offset + e.length, end); return { ...e, offset: s - start, length: f - s }; })
        .filter((e) => e.length > 0);
      blocks.push(ents.length ? { type: 'p', text: line, entities: ents } : { type: 'p', text: line });
      at = end + 1;
    }
  };
  let pos = 0;
  for (const p of pres) {
    if (p.offset > pos) para(pos, Math.max(pos, p.offset - (text[p.offset - 1] === '\n' ? 1 : 0)));
    blocks.push({ type: 'code', text: text.slice(p.offset, p.offset + p.length) });
    pos = p.offset + p.length + (text[p.offset + p.length] === '\n' ? 1 : 0);
  }
  if (pos < text.length || !blocks.length) para(pos, text.length);
  return blocks;
}
