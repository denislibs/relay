// Адреса файлов сборки. Код и стили собираются с хэшем в имени (main-3f9a1c2d.js) и кэшируются навсегда;
// какое имя у файла в этой сборке, build.ts вписывает в index.html (self.__ASSETS__). Без таблицы
// (тесты, старая разметка) — имя как есть.
declare global { var __ASSETS__: Record<string, string> | undefined }

export function asset(name: string): string {
  return globalThis.__ASSETS__?.[name] ?? '/' + name;
}
