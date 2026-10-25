/**
 * Тайлы карты для пузыря геопозиции — через свой сервер, а не из браузера: политика безопасности не пускает чужие
 * картинки, и так координаты собеседника не утекают картографическому сервису с каждого устройства. Сервер берёт
 * тайл у источника (MAP_TILES, по умолчанию OpenStreetMap — с честным User-Agent, как требуют их правила) и держит
 * в памяти последние MAX штук; браузер кэширует на неделю.
 */
const SOURCE = () => process.env.MAP_TILES ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAX = 2000;
const cache = new Map<string, { body: ArrayBuffer; type: string }>();
const inflight = new Map<string, Promise<{ body: ArrayBuffer; type: string } | null>>();

export const ZOOM_MIN = 3, ZOOM_MAX = 18;

/** null — нет такого тайла или источник недоступен (клиент рисует заглушку). */
export async function mapTile(z: number, x: number, y: number): Promise<{ body: ArrayBuffer; type: string } | null> {
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < ZOOM_MIN || z > ZOOM_MAX || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }   // свежий — в конец (LRU)
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const url = SOURCE().replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      const res = await fetch(url, { headers: { 'user-agent': 'Relay messenger (map preview; self-hosted)' }, signal: AbortSignal.timeout(5000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(type)) return null;
      const tile = { body: await res.arrayBuffer(), type };
      cache.set(key, tile);
      if (cache.size > MAX) cache.delete(cache.keys().next().value!);
      return tile;
    } catch { return null; } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}
