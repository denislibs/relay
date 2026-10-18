/**
 * Минимальный клиент Meilisearch поверх fetch. Мастер-ключ — только у сервера и воркера.
 * Изменения в Meilisearch асинхронные: ответ — taskUid, готовность — waitTask.
 */
export class MeiliError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
}

const base = () => { const u = process.env.MEILI_URL; if (!u) throw new Error('MEILI_URL is not set'); return u; };

export async function meili<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base() + path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${process.env.MEILI_MASTER_KEY ?? ''}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new MeiliError(res.status, json?.code, json?.message ?? `meilisearch ${res.status}`);
  return json as T;
}

export async function waitTask(taskUid: number, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
    const t = await meili<{ status: string; error?: { message: string; code: string } }>(`/tasks/${taskUid}`);
    if (t.status === 'succeeded') return;
    if (t.status === 'failed' || t.status === 'canceled') throw new MeiliError(500, t.error?.code, t.error?.message ?? `task ${taskUid} ${t.status}`);
    if (Date.now() > until) throw new Error(`meilisearch task ${taskUid} timed out`);
    await Bun.sleep(delay);
  }
}

export const indexName = (base: string): string => `${process.env.SEARCH_INDEX_PREFIX ?? 'relay'}_${base}`;
