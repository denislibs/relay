// Данные разделов настроек. Предзагрузка: на главной странице и при наведении на строку раздела —
// слайд приезжает уже заполненным. Пока пусто, последующие задачи подключают свои подписки.

const loaders = new Map<string, () => void>();

/** Раздел регистрирует свою предзагрузку (идемпотентную). */
export function registerPrefetch(path: string, load: () => void): void { loaders.set(path, load); }

export function prefetch(path: string): void {
  try { loaders.get(path)?.(); } catch { /* предзагрузка не должна ломать интерфейс */ }
}

/** Пути разделов главной страницы — предзагружаем все при открытии. */
export function prefetchAll(paths: string[]): void { for (const p of paths) prefetch(p); }
