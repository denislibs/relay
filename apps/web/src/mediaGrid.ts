// Чистые расчёты для вкладок «Общих медиа» (ui/SharedMedia.tsx): какой адрес грузит плитка.

type Variant = { name: string; w: number; h: number; size: number };
export type TileAtt = { id: string; kind: string; mime: string; preview?: Variant | null };

/** Плитка фото: маленькая копия сервера (jobs/photo.ts, до 480 px), пока её нет — оригинал. */
export const tileSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`);

/** Кадр видео без миниатюры: короткий немой ролик сервера (jobs/video.ts, 360p), пока его нет — оригинал;
 *  #t=0.1 — не чёрный самый первый кадр. */
export const videoFrameSrc = (a: TileAtt): string => (a.preview ? `/files/${a.id}/preview` : `/files/${a.id}`) + '#t=0.1';
