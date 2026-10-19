// Плитка ссылки в «Общих медиа» и глобальном поиске, как в Telegram: картинка превью страницы (если есть),
// иначе — первая буква сайта. Заголовок и описание — из превью, если оно загружено, иначе — сайт и текст сообщения.
type Link = { url: string; pending?: boolean; siteName?: string | null; title?: string | null; description?: string | null; photo?: { id: string; w: number; h: number } | null };

export function linkInfo(m: { link?: unknown; body: string }, raw: string, host: string): { title: string; desc: string; photo: string | null } {
  const l = (m.link as Link | null | undefined) ?? null;
  const ok = l && !l.pending ? l : null;
  const rest = m.body.replace(raw, '').replace(/\s+/g, ' ').trim();
  return {
    title: ok?.title || ok?.siteName || host,
    desc: (ok?.description || rest).slice(0, 170),
    photo: ok?.photo ? `/files/${ok.photo.id}` : null,
  };
}

export function LinkTile({ photo, host }: { photo: string | null; host: string }) {
  return photo
    ? <span class="app-sm-letter app-sm-thumb" aria-hidden="true"><img src={photo} alt="" loading="lazy" decoding="async" /></span>
    : <span class="app-sm-letter" aria-hidden="true">{(host[0] ?? '?').toUpperCase()}</span>;
}
