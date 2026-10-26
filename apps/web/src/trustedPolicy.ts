// Политика Trusted Types «default» без DOMPurify — чтобы её можно было поставить уже в boot.js (early.ts, ранний
// старт движка: адрес SharedWorker тоже проходит через политику). Правила те же, что всегда (trustedTypes.ts):
//   адрес скрипта — только свой origin; текст скрипта — никогда; HTML — через санитайзер, который подключает main
//   (до этого запись HTML в DOM отклоняется: в <head> её нет, но если будет — не пропустим непроверенное).

type Policy = { createHTML?: (s: string) => string; createScriptURL?: (s: string) => string; createScript?: (s: string) => string };
export type TT = { createPolicy(name: string, p: Policy): unknown; defaultPolicy?: unknown };
type Hook = { setSanitizer(fn: (s: string) => string): void };

/** Адрес скрипта своего origin — как есть; чужой — отказ. */
export function sameOriginScriptUrl(s: string, origin = location.origin): string {
  const u = new URL(s, origin);
  if (u.origin !== origin) throw new TypeError(`Trusted Types: script from ${u.origin} is not allowed`);
  return u.href;
}

/**
 * Поставить политику default. Если её уже поставил boot.js — только подключить санитайзер HTML.
 * false — Trusted Types нет или чужая политика default уже стоит.
 */
export function installDefaultPolicy(scope: { trustedTypes?: TT; __relayTT?: Hook } = globalThis as never, sanitize?: (s: string) => string): boolean {
  if (scope.__relayTT) { if (sanitize) scope.__relayTT.setSanitizer(sanitize); return true; }
  const tt = scope.trustedTypes;
  if (!tt?.createPolicy || tt.defaultPolicy) return false;
  let html = sanitize ?? null;
  tt.createPolicy('default', {
    createHTML: (s) => { if (!html) throw new TypeError('Trusted Types: HTML before the sanitizer is installed'); return html(s); },
    createScriptURL: (s) => sameOriginScriptUrl(s),
    createScript: () => { throw new TypeError('Trusted Types: inline script is not allowed'); },
  });
  scope.__relayTT = { setSanitizer: (fn) => { html = fn; } };
  return true;
}
