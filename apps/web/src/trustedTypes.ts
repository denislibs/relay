// Trusted Types (CSP: require-trusted-types-for 'script', docker/nginx/security-headers.conf). Строка в опасное место
// DOM — innerHTML, DOMParser, адрес воркера или Service Worker — проходит через политику:
//   HTML           — DOMPurify: без <script>, обработчиков on*, javascript: и прочего исполняемого;
//   адрес скрипта  — только свой origin (воркеры, Service Worker); чужой — ошибка;
//   текст скрипта  — никогда (eval и строковые таймеры).
// Импортируется первым в main.tsx: политика должна стоять до первой записи в DOM. Сама политика — trustedPolicy.ts:
// её ставит уже boot.js (ранний старт движка, early.ts), здесь к ней подключается DOMPurify. Иконки — своя политика (kit.js).
import DOMPurify from 'dompurify';
import { installDefaultPolicy, type TT } from './trustedPolicy';

export { sameOriginScriptUrl } from './trustedPolicy';

/** HTML без исполняемого: поле ввода (contenteditable, data-*), ссылки с target, SVG. */
export const sanitizeHtml = (s: string): string => DOMPurify.sanitize(s, { ADD_ATTR: ['contenteditable', 'target'] });

export function installTrustedTypes(scope: { trustedTypes?: TT } = globalThis as never): boolean {
  return installDefaultPolicy(scope, sanitizeHtml);
}

installTrustedTypes();
