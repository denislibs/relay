// Сборка клиента в dist: main, Service Worker, два хоста движка, html и стили дизайн-системы.
//   bun apps/web/build.ts            — одна сборка
//   bun apps/web/build.ts --watch    — пересборка при изменениях (dev)
import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = import.meta.dir;
const ui = join(root, '..', '..', 'packages', 'relay-ui');
const engineHosts = join(root, '..', '..', 'packages', 'sync-engine', 'src', 'hosts');
const dist = join(root, 'dist');
const isWatch = process.argv.includes('--watch');

async function build(): Promise<void> {
  const BUILD = process.env.BUILD_ID ?? Date.now().toString(36);
  await Bun.$`bun ${join(ui, 'build-tokens.ts')}`.quiet();
  const tmp = dist + '.tmp';
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const res = await Bun.build({
    entrypoints: [join(root, 'src', 'main.tsx'), join(root, 'src', 'sw.ts'), join(engineHosts, 'shared.worker.ts'), join(engineHosts, 'dedicated.worker.ts'), join(ui, 'src', 'spoiler.worker.js'), join(ui, 'src', 'articleEditor.js')],   // articleEditor — Tiptap, грузится при первом развороте
    outdir: tmp,
    target: 'browser',
    naming: '[name].[ext]',
    minify: !isWatch,
    sourcemap: 'linked',
    define: { __BUILD__: JSON.stringify(BUILD), __DEV__: JSON.stringify(isWatch) },
  });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    if (!isWatch) process.exit(1);
    return;
  }
  await cp(join(root, 'public'), tmp, { recursive: true });
  // открытые вкладки сверяют свою сборку с этой (update.ts) и предлагают обновиться
  await Bun.write(join(tmp, 'version.json'), JSON.stringify({ build: BUILD }));
  await cp(join(ui, 'relay.css'), join(tmp, 'relay.css'));
  await cp(join(ui, 'tokens.css'), join(tmp, 'tokens.css'));
  // стикеры: исходники на TS → .tgs; движок Lottie (ThorVG, WASM) — рядом, без CDN: работает и без сети
  await Bun.$`bun ${join(ui, 'stickers', 'build.ts')} ${join(tmp, 'stickers')}`.quiet();
  await cp(join(dirname(Bun.resolveSync('@lottiefiles/dotlottie-web', ui)), 'dotlottie-player.wasm'), join(tmp, 'dotlottie-player.wasm'));
  // поверх старой сборки, без удаления папки: сервер ни на миг не остаётся без index.html
  await cp(tmp, dist, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
  console.log(`web built ${BUILD}`);
}

await build();
if (isWatch) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const again = (_e: string, file: string | null) => {
    if (file && /(^|\/)tokens\.css$/.test(file)) return; // результат build-tokens, а не исходник
    clearTimeout(t); t = setTimeout(() => build().catch(console.error), 150);
  };
  for (const dir of [join(root, 'src'), join(root, 'public'), join(ui), join(root, '..', '..', 'packages', 'sync-engine', 'src')]) fsWatch(dir, { recursive: true }, again);
}
