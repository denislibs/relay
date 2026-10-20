import { clearRecent, featuredSets, getStickerSet, myStickers, searchSets, setFaved, setInstalled, stickersByEmoji } from '../domain/stickers';

const fail = (code: string, status: number) => Response.json({ code }, { status });

/** /sticker-sets/*, /my-stickers/*, /stickers-by-emoji — паки, мои стикеры и поиск по эмодзи (нужна сессия). */
export async function stickerRoute(req: Request, url: URL, userId: number): Promise<Response | null> {
  const p = url.pathname, m = req.method;
  if (m === 'GET' && p === '/sticker-sets/featured') return Response.json(await featuredSets(Number(url.searchParams.get('offset')) || 0));
  if (m === 'GET' && p === '/sticker-sets/search') return Response.json(await searchSets(url.searchParams.get('q') ?? ''));
  const one = /^\/sticker-sets\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (m === 'GET' && one) {
    const set = await getStickerSet(one[1]);
    if (!set) return fail('not_found', 404);
    // набор меняется только переимпортом: клиент держит его по hash
    if (req.headers.get('if-none-match') === `"${set.hash}"`) return new Response(null, { status: 304 });
    return Response.json(set, { headers: { etag: `"${set.hash}"`, 'cache-control': 'private, no-cache' } });
  }
  if (m === 'GET' && p === '/stickers-by-emoji') return Response.json(await stickersByEmoji(userId, url.searchParams.get('e') ?? ''));
  if (m === 'GET' && p === '/my-stickers') return Response.json(await myStickers(userId));
  if (m === 'POST' && p === '/my-stickers/sets') {
    const b = (await req.json().catch(() => null)) as { setId?: unknown; on?: unknown } | null;
    if (!b || !Number.isInteger(b.setId) || typeof b.on !== 'boolean') return fail('bad_frame', 400);
    await setInstalled(userId, b.setId as number, b.on);
    return Response.json({ ok: true });
  }
  if (m === 'POST' && p === '/my-stickers/faved') {
    const b = (await req.json().catch(() => null)) as { id?: unknown; on?: unknown } | null;
    if (!b || !Number.isInteger(b.id) || typeof b.on !== 'boolean') return fail('bad_frame', 400);
    await setFaved(userId, b.id as number, b.on);
    return Response.json({ ok: true });
  }
  if (m === 'DELETE' && p === '/my-stickers/recent') {
    const id = url.searchParams.get('id');
    await clearRecent(userId, id && /^\d+$/.test(id) ? Number(id) : undefined);
    return Response.json({ ok: true });
  }
  return null;
}
