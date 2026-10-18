// Первая ссылка в тексте — для превью в поле ввода. Те же правила, что у сервера (domain/linkPreview.ts firstUrl):
// http(s):// или www., хвостовая пунктуация отбрасывается; ссылка из оформления (текст-ссылка) — если она раньше.
import type { Entity } from '@relay/protocol';
import type { LinkPreview } from '@relay/protocol';

export function firstUrl(body: string, entities: Entity[] = []): string | null {
  const ent = entities.filter((e) => e.type === 'link' && e.url).sort((a, b) => a.offset - b.offset)[0];
  const m = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/i.exec(body);
  const fromText = m ? m[0].replace(/[.,!?:;)\]}»"']+$/, '') : null;
  const pick = ent && (!m || ent.offset <= m.index) ? ent.url! : fromText;
  if (!pick) return null;
  try {
    const u = new URL(/^www\./i.test(pick) ? 'https://' + pick : pick);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

const cache = new Map<string, Promise<LinkPreview | null>>();
/** Превью для поля ввода (сервер грузит и кэширует страницу). Ошибка — без превью, повторим позже. */
export function loadPreview(url: string): Promise<LinkPreview | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch('/link-preview?url=' + encodeURIComponent(url)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { link: LinkPreview | null }) => j.link).catch(() => { cache.delete(url); return null; });
    cache.set(url, p);
  }
  return p;
}
