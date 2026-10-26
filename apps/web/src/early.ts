// Ранний старт движка. Сборка (build.ts) вклеивает этот файл в boot.js (обычный скрипт в <head>), поэтому он
// выполняется до разбора стилей и задолго до main: SharedWorker грузит свой код и открывает базу, пока страница
// ещё разбирается и рисует каркас. Хост берёт конфиг первого hello, так что он строго тот же, что у вкладки
// (engineConfig.ts); main потом подключается к уже открытому движку и закрывает этот порт (data.ts).
// Только если здесь уже входили (профиль на устройстве): иначе первым будет экран входа.
import { engineConfig } from './engineConfig';
import type { Me } from './global';
import { installDefaultPolicy } from './trustedPolicy';

declare const __BUILD__: string;
declare const __SHARED_URL__: string;

try {
  const me = JSON.parse(localStorage.getItem('relay.me') ?? 'null') as Me | null;
  if (me && typeof me.userId === 'number' && typeof SharedWorker === 'function') {
    installDefaultPolicy();   // адрес воркера — через Trusted Types (CSP); main потом подключит к политике DOMPurify
    const w = new SharedWorker(__SHARED_URL__, { type: 'module', name: 'relay@' + __BUILD__ });
    w.port.start();
    w.port.postMessage({ t: 'hello', build: __BUILD__, config: engineConfig(me) });
    (self as unknown as { __relayEarly?: { close(): void } }).__relayEarly = {
      close: () => { try { w.port.postMessage({ t: 'bye' }); w.port.close(); } catch { /* уже закрыт */ } },
    };
  }
} catch { /* приватный режим, нет SharedWorker — движок поднимет main, как обычно */ }
