// Сборка стикеров: stickers/*.ts → <out>/<name>.tgs (Lottie JSON в gzip, как TGS в Telegram).
//   bun packages/relay-ui/stickers/build.ts <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cake } from './cake';
import { folder } from './folder';
import { folderNew } from './folderNew';
import { key } from './key';
import { link } from './link';

const STICKERS: Record<string, () => object> = { cake, folder, folderNew, key, link };

const out = process.argv[2];
if (!out) throw new Error('usage: build.ts <outDir>');
await mkdir(out, { recursive: true });
for (const [name, make] of Object.entries(STICKERS)) {
  await Bun.write(join(out, name + '.tgs'), Bun.gzipSync(new TextEncoder().encode(JSON.stringify(make()))));
}
