import { SPOILER_FILL } from '@relay/protocol';
import { SpoilerText } from '@relay/ui';
import type { ComponentChildren } from 'preact';
import { hideCode } from './format';

/** Превью последнего сообщения в строке чата — по правилам Telegram:
 *  оформление снимается, спойлер скрыт (настоящий текст в DOM не попадает), переносы — пробелы, не длиннее 200 знаков. */

type Ent = { type: string; offset: number; length: number };
export type LastMessage = {
  senderId: number; body: string; deleted?: boolean; kind?: string; attachmentName?: string | null; attachmentTitle?: string | null; attachmentPerformer?: string | null;
  entities?: Ent[] | null; thumb?: string | null; mime?: string | null; service?: { type: string } | null;
};

/** Сообщение ленты (вложение — объектом) → формат превью списка чатов (поля вложения — плоско). */
export function asLast(m: Record<string, unknown>): LastMessage {
  const a = (m.attachment ?? null) as { name?: string; title?: string | null; performer?: string | null; thumb?: string | null; mime?: string } | null;
  return {
    senderId: m.senderId as number, body: String(m.body ?? ''), deleted: !!m.deleted, kind: (m.kind as string) ?? 'text',
    attachmentName: a?.name ?? null, attachmentTitle: a?.title ?? null, attachmentPerformer: a?.performer ?? null,
    entities: (m.entities as LastMessage['entities']) ?? null, thumb: a?.thumb ?? null, mime: a?.mime ?? null,
    service: (m.service as LastMessage['service']) ?? null,
  };
}

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

/** Миниатюра 20 px из встроенного thumb (без загрузки файла): фото, видео (со значком play),
 *  обложка музыки, кружок видеосообщения — как в Telegram. */
export function previewThumb(m: LastMessage): { src: string; video: boolean; round?: boolean } | null {
  if (m.deleted || !m.thumb) return null;
  if (m.kind === 'round') return { src: m.thumb, video: false, round: true };
  const video = !!m.mime?.startsWith('video/');
  if (m.kind !== 'photo' && m.kind !== 'audio' && !video) return null;
  return { src: m.thumb, video };
}

/** Текст после имени: подпись к медиа, а без подписи — тип. С миниатюрой эмодзи типа не нужен. */
export function previewBody(m: LastMessage, withThumb: boolean): ComponentChildren {
  if (m.deleted) return 'Сообщение удалено';
  if (m.service?.type === 'group_created') return `Создана группа «${m.body}»`;
  // код входа в списке не показываем: цифры — точками, оформление (code над цифрами) отбрасываем
  const code = m.service?.type === 'login_code';
  const text = code ? hideCode(m.body) : m.body;
  const entities = code ? [] : m.entities;
  const caption = text ? previewText(text, entities) : null;
  if (m.kind === 'photo') return caption ?? (withThumb ? 'Фото' : '🖼 Фото');
  if (m.kind === 'voice') return caption ?? '🎤 Голосовое сообщение';
  if (m.kind === 'round') return withThumb ? 'Видеосообщение' : '📹 Видеосообщение';
  if (m.kind === 'audio') {
    // «Название — исполнитель»; с обложкой эмодзи не нужен
    const name = m.attachmentTitle || (m.attachmentName ?? 'Музыка').replace(/\.[^.]{1,5}$/, '');
    const track = m.attachmentPerformer ? name + ' — ' + m.attachmentPerformer : name;
    return withThumb ? caption ?? track : ['🎧 ', caption ?? track];
  }
  if (m.kind === 'file') {
    if (m.mime?.startsWith('video/')) return withThumb ? caption ?? 'Видео' : ['📹 ', caption ?? 'Видео'];
    return ['📎 ', caption ?? m.attachmentName ?? 'Файл'];
  }
  return caption ?? '';
}
