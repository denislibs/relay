/** Вложение найденного сообщения — то, что нужно строке поиска. */
export interface HitAttachment { kind: string; name: string; mime?: string; title?: string | null; performer?: string | null }

const ICON: Record<string, string> = { photo: '🖼', audio: '🎧', voice: '🎤', round: '📹' };

/**
 * Строка поиска для сообщения, найденного по вложению (имя файла, название или исполнитель трека): «🎧 Название —
 * Исполнитель», «📎 отчёт.pdf». null — показывать текст сообщения: совпал он, или вложения нет. Совпадение,
 * которое нашёл только Meilisearch (опечатка), подсветить нечем: тогда вложение — лишь у сообщения без текста.
 * body — текст, как его показывают (shownBody), q — запрос.
 */
export function attachmentHit(body: string, a: HitAttachment | null | undefined, q: string): string | null {
  if (!a) return null;
  const lq = q.trim().toLowerCase();
  if (lq && body.toLowerCase().includes(lq)) return null;
  const icon = ICON[a.kind] ?? (a.mime?.startsWith('video/') ? '📹' : '📎');
  const has = (v: string | null | undefined): v is string => !!v && !!lq && v.toLowerCase().includes(lq);
  // трек: «Название — Исполнитель», как в списке чатов; совпало только имя файла — его и показываем
  const track = a.kind === 'audio' && (a.title || a.performer)
    ? (a.title || a.name.replace(/\.[^.]{1,5}$/, '')) + (a.performer ? ' — ' + a.performer : '') : null;
  if (track && (has(a.title) || has(a.performer))) return icon + ' ' + track;
  if (has(a.name)) return icon + ' ' + a.name;
  return body ? null : icon + ' ' + (track ?? a.name);
}
