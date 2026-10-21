// Проверка файлов сборки в Service Worker (sw.ts); таблицу хэшей строит build.ts.
/**
 * Целостность сборки: файл с хэшем в имени отдаётся странице, только если его байты совпали с таблицей этой сборки
 * (её зашил build.ts в sw.js, а sw.js браузер берёт с нашего сервера мимо кэшей). Подмена кода в CDN, HTTP-кэше
 * или по дороге — ошибка загрузки, а не чужой скрипт с доступом к ключу устройства. Файлы без записи — как есть.
 */
export async function verified(res: Response, path: string, table: Record<string, string>): Promise<Response> {
  const want = table[path];
  if (!want || !res.ok) return res;
  const body = await res.arrayBuffer();
  const got = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', body))));
  if (got !== want) throw new Error(`integrity check failed: ${path}`);
  // тело уже распаковано: заголовки сжатия и длины от сети к нему не относятся
  const headers = new Headers(res.headers);
  headers.delete('content-encoding'); headers.delete('content-length');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}
