// Trusted Types (CSP: require-trusted-types-for 'script', docker/nginx/security-headers.conf). Строка в опасное место
// DOM — innerHTML, DOMParser, адрес воркера или Service Worker — проходит через политику:
//   HTML           — DOMPurify: без <script>, обработчиков on*, javascript: и прочего исполняемого;
//   адрес скрипта  — только свой origin (воркеры, Service Worker); чужой — ошибка;
//   текст скрипта  — никогда (eval и строковые таймеры).
// Импортируется первым в main.tsx: политика должна стоять до первой записи в DOM. Иконки — своя политика (kit.js).
import DOMPurify from 'dompurify';

type Policy = { createHTML?: (s: string) => string; createScriptURL?: (s: string) => string; createScript?: (s: string) => string };
type TT = { createPolicy(name: string, p: Policy): unknown; defaultPolicy?: unknown };

/** HTML без исполняемого: поле ввода (contenteditable, data-*), ссылки с target, SVG. */
export const sanitizeHtml = (s: string): string => DOMPurify.sanitize(s, { ADD_ATTR: ['contenteditable', 'target'] });

/** Адрес скрипта своего origin — как есть; чужой — отказ. */
export function sameOriginScriptUrl(s: string, origin = location.origin): string {
  const u = new URL(s, origin);
  if (u.origin !== origin) throw new TypeError(`Trusted Types: script from ${u.origin} is not allowed`);
  return u.href;
}

export function installTrustedTypes(scope: { trustedTypes?: TT } = globalThis as never): boolean {
  const tt = scope.trustedTypes;
  if (!tt?.createPolicy || tt.defaultPolicy) return false;
  tt.createPolicy('default', {
    createHTML: sanitizeHtml,
    createScriptURL: (s) => sameOriginScriptUrl(s),
    createScript: () => { throw new TypeError('Trusted Types: inline script is not allowed'); },
  });
  return true;
}

installTrustedTypes();
