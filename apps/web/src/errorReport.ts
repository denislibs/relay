// Ошибки страницы и сбои звонков — на сервер (POST /client-errors, docs/observability.md). Кольцо раздела
// «Для разработчиков» (devtools/metrics.ts) видно только на этом устройстве; отчёт — владельцу сервера.
import { createErrorReporter, reportUncaught } from '@relay/sync-engine/src/errorReport';

declare const __BUILD__: string;

export const errorReporter = createErrorReporter({ build: typeof __BUILD__ === 'string' ? __BUILD__ : 'dev' });

let installed = false;
/** Один раз при старте: window.onerror, unhandledrejection; на уходе со страницы — отправить накопленное. */
export function installErrorReport(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  reportUncaught(window, errorReporter, { error: 'window', rejection: 'promise' });
  addEventListener('pagehide', () => errorReporter.flush(true));
}
