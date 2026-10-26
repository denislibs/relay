import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const pub = join(import.meta.dir, '..', 'public');
const manifest = await Bun.file(join(pub, 'manifest.webmanifest')).json() as {
  start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[];
};
/** Ширина и высота PNG из заголовка IHDR. */
const pngSize = (b: Uint8Array) => { const v = new DataView(b.buffer, b.byteOffset); return [v.getUint32(16), v.getUint32(20)]; };

describe('PWA manifest', () => {
  test('installable basics: standalone, start inside scope, 192 and 512 icons, maskable ones', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    const png = manifest.icons.filter((i) => i.type === 'image/png');
    for (const size of ['192x192', '512x512']) {
      expect(png.some((i) => i.sizes === size && i.purpose === 'any')).toBe(true);
      expect(png.some((i) => i.sizes === size && i.purpose === 'maskable')).toBe(true);
    }
  });

  test('every icon exists and its pixels match the declared size', async () => {
    for (const i of manifest.icons) {
      const f = Bun.file(join(pub, i.src));
      expect(await f.exists()).toBe(true);
      if (i.type !== 'image/png') continue;
      expect(pngSize(await f.bytes()).join('x')).toBe(i.sizes);
    }
  });

  test('index.html links the manifest and the iOS icon', async () => {
    const html = await Bun.file(join(pub, 'index.html')).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    const touch = /rel="apple-touch-icon" href="([^"]+)"/.exec(html)![1];
    expect(pngSize(await Bun.file(join(pub, touch)).bytes())).toEqual([180, 180]);
  });
});
