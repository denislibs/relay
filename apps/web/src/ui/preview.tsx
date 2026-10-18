import { SPOILER_FILL } from '@relay/protocol';
import { SpoilerText } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { hideCode } from './format';

/** Превью последнего сообщения в строке чата — по правилам Telegram:
 *  оформление снимается, спойлер скрыт (настоящий текст в DOM не попадает), переносы — пробелы, не длиннее 200 знаков. */

type Ent = { type: string; offset: number; length: number };
export type LastMessage = {
  senderId: number; body: string; deleted?: boolean; kind?: string; attachmentName?: string | null; attachmentTitle?: string | null;
  entities?: Ent[] | null; thumb?: string | null; mime?: string | null; service?: { type: string } | null;
};

const MAX = 200;

/** Текст с оформлением → куски для строки: обычный текст и спрятанные спойлеры. */
export function previewText(text: string, entities?: Ent[] | null): ComponentChildren {
  const spoilers = (entities ?? []).filter((e) => e.type === 'spoiler').sort((a, b) => a.offset - b.offset);
  const out: ComponentChildren[] = [];
  let at = 0, left = MAX;
  const plain = (s: string) => {
    const t = s.replace(/\s+/g, ' ').slice(0, left);
    left -= t.length;
    if (t) out.push(t);
  };
  for (const e of spoilers) {
    if (left <= 0) break;
    if (e.offset > at) plain(text.slice(at, e.offset));
    if (left <= 0) break;
    const n = Math.min(e.length, left);
    let hidden = '';
    for (let i = 0; i < n; i++) hidden += text[e.offset + i] === ' ' ? ' ' : SPOILER_FILL[(e.offset + i) % SPOILER_FILL.length];
    out.push(<SpoilerText key={e.offset}>{hidden}</SpoilerText>);   // те же частицы, что в ленте; внутри — заглушка
    left -= n;
    at = Math.max(at, e.offset + e.length);
  }
  if (left > 0 && at < text.length) plain(text.slice(at));
  return out;
}

/** Миниатюра 20 px: у фото — встроенный thumb; у видео сверху значок play. */
export function previewThumb(m: LastMessage): { src: string; video: boolean } | null {
  if (m.deleted || !m.thumb) return null;
  const video = !!m.mime?.startsWith('video/');
  if (m.kind !== 'photo' && !video) return null;
  return { src: m.thumb, video };
}

/** Текст после имени: подпись к медиа, а без подписи — тип. С миниатюрой эмодзи типа не нужен. */
export function previewBody(m: LastMessage, withThumb: boolean): ComponentChildren {
  if (m.deleted) return 'Сообщение удалено';
  // код входа в списке не показываем: цифры — точками, оформление (code над цифрами) отбрасываем
  const code = m.service?.type === 'login_code';
  const text = code ? hideCode(m.body) : m.body;
  const entities = code ? [] : m.entities;
  const caption = text ? previewText(text, entities) : null;
  if (m.kind === 'photo') return caption ?? (withThumb ? 'Фото' : '🖼 Фото');
  if (m.kind === 'voice') return 'Голосовое сообщение';
  if (m.kind === 'round') return 'Видеосообщение';
  if (m.kind === 'audio') return ['🎵 ', caption ?? m.attachmentTitle ?? (m.attachmentName ?? 'Музыка').replace(/\.[^.]{1,5}$/, '')];
  if (m.kind === 'file') {
    if (withThumb) return caption ?? 'Видео';
    return ['📎 ', caption ?? m.attachmentName ?? 'Файл'];
  }
  return caption ?? '';
}
