// Сеанс, привязанный к устройству (packages/sync-engine/src/device.ts, сервер — apps/server/src/deviceAuth.ts):
// запросы страницы и Service Worker к своему серверу при 401 «обнови доступ» подписывают вызов ключом устройства и
// повторяются; страница вошедшего пользователя обновляет короткий доступ заранее — картинки и видео (<img>, <video>
// без SW) не упираются в истёкший cookie. Первое обновление привязывает сеанс к ключу этого браузера.
import { deviceFetch, forgetDeviceKey, refreshAccess } from '@relay/sync-engine/src/device';

const EVERY_MS = 4 * 60_000;   // доступ живёт 10 минут
type Scope = { fetch: typeof fetch; location: { origin: string } };

/** Свои запросы этого контекста (страница или SW) — через обновление доступа; чужие origin — как есть. */
export function installDeviceFetch(scope: Scope = globalThis as unknown as Scope): void {
  const native = scope.fetch.bind(scope);
  const wrapped = deviceFetch((u, i) => native(u, i));
  const own = (input: RequestInfo | URL): boolean => {
    try { return new URL(input instanceof Request ? input.url : String(input), scope.location.origin).origin === scope.location.origin; } catch { return false; }
  };
  scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (own(input) ? wrapped(input as string, init) : native(input, init))) as typeof fetch;
}

let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
/** Вошли: привязать сеанс (первое обновление) и держать доступ свежим, пока вкладка жива. */
export function startDeviceAuth(): void {
  if (timer) return;
  const tick = () => {
    if (document.visibilityState !== 'visible' && Date.now() - last < 9 * 60_000) return;   // в фоне — реже, но не дать истечь
    last = Date.now();
    void refreshAccess().catch(() => { last = 0; });   // нет сети — повторим на следующем тике
  };
  tick();
  timer = setInterval(tick, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > EVERY_MS) tick(); });
}

/** Выход или сеанс завершён: перестать обновлять, ключ устройства забыть (новый вход — новый ключ). */
export function stopDeviceAuth(): void {
  if (timer) clearInterval(timer);
  timer = null; last = 0;
  void forgetDeviceKey();
}
