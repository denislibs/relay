import { reactionCatalog } from './catalog';

/** GET /reactions — каталог реакций (нужна сессия). Клиент держит его по ETag час, дальше — условный запрос. */
export async function reactionsRoute(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || url.pathname !== '/reactions') return null;
  const cat = await reactionCatalog();
  const etag = `"${cat.hash}"`;
  const headers = { etag, 'cache-control': 'private, max-age=3600' };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return Response.json(cat, { headers });
}
