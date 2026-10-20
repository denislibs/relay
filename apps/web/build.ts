// Сборка клиента в dist: main, Service Worker, два хоста движка, html и стили дизайн-системы.
// Код и стили — с хэшем в имени (кэш навсегда), index.html / sw.js / version.json — без (перепроверяются).
//   bun apps/web/build.ts            — одна сборка
//   bun apps/web/build.ts --watch    — пересборка при изменениях (dev)
import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { brotliCompressSync, constants as Z, gzipSync } from 'node:zlib';

const root = import.meta.dir;
const ui = join(root, '..', '..', 'packages', 'relay-ui');
const engineHosts = join(root, '..', '..', 'packages', 'sync-engine', 'src', 'hosts');
const dist = process.env.WEB_OUT ?? join(root, 'dist');   // WEB_OUT — собрать в другую папку (проверка продакшен-сборки)
const isWatch = process.argv.includes('--watch');

const HASHED = /-[a-z0-9]{8,}\.(js|css|wasm)(\.map|\.gz|\.br)?$/;   // имя с хэшем: кэшируется навсегда (docker/nginx)
const LEGACY = ['main.js', 'main.js.map', 'shared.worker.js', 'shared.worker.js.map', 'dedicated.worker.js', 'dedicated.worker.js.map', 'spoiler.worker.js', 'spoiler.worker.js.map', 'articleEditor.js', 'articleEditor.js.map', 'relay.css', 'tokens.css', 'app.css'];
const HISTORY = '.assets-history.json';   // файлы двух последних сборок: открытые вкладки прежней ещё догружают свои

/** name.css → name-<хэш>.css; возвращает публичный адрес. */
async function hashedCopy(src: string, dir: string, name: string): Promise<string> {
  const body = await Bun.file(src).bytes();
  const file = name.replace(/\.(css|wasm)$/, (ext) => '-' + Bun.hash(body).toString(36).padStart(8, '0').slice(0, 10) + ext);
  await Bun.write(join(dir, file), body);
  return '/' + file;
}

/** Готовые .gz/.br рядом с файлом — nginx отдаёт их без сжатия на запрос (gzip_static/brotli_static). */
async function precompress(dir: string): Promise<void> {
  for (const f of new Bun.Glob('**/*.{js,css,html,json,svg,wasm}').scanSync(dir)) {
    const path = join(dir, f), body = await Bun.file(path).bytes();
    if (body.length < 1024) continue;
    await Bun.write(path + '.gz', gzipSync(body, { level: 9 }));
    await Bun.write(path + '.br', brotliCompressSync(body, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_SIZE_HINT]: body.length } }));
  }
}

async function build(): Promise<void> {
  const BUILD = process.env.BUILD_ID ?? Date.now().toString(36);
  await Bun.$`bun ${join(ui, 'build-tokens.ts')}`.quiet();
  const tmp = dist + '.tmp';
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const define = { __BUILD__: JSON.stringify(BUILD), __DEV__: JSON.stringify(isWatch) };
  const res = await Bun.build({
    entrypoints: [join(root, 'src', 'main.tsx'), join(engineHosts, 'shared.worker.ts'), join(engineHosts, 'dedicated.worker.ts'), join(ui, 'src', 'spoiler.worker.js'), join(ui, 'src', 'lottie', 'lottie.worker.js'), join(ui, 'src', 'articleEditor.js'), join(root, 'src', 'media', 'videoTranscode.ts')],   // articleEditor — Tiptap, грузится при первом развороте; videoTranscode — Mediabunny, при первом сжатии видео
    outdir: tmp,
    target: 'browser',
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    minify: !isWatch,
    sourcemap: 'linked',
    define,
  });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    if (!isWatch) process.exit(1);
    return;
  }
  // логическое имя → адрес с хэшем: код берёт его из index.html (src/assets.ts)
  const assets: Record<string, string> = {};
  for (const o of res.outputs) {
    if (o.kind !== 'entry-point') continue;
    const file = basename(o.path);
    assets[file.replace(/-[a-z0-9]{8,}(\.js)$/, '$1')] = '/' + file;
  }
  await cp(join(root, 'public'), tmp, { recursive: true });
  // tlottie (MIT, собран из исходников — packages/relay-ui/vendor/tlottie/BUILD.md): имя с хэшем, кэш навсегда
  for (const w of ['tlottie.wasm', 'tlottie-no-simd.wasm']) assets[w] = await hashedCopy(join(ui, 'vendor', 'tlottie', w), tmp, w);
  await rm(join(tmp, 'app.css'), { force: true });
  const css = {
    'tokens.css': await hashedCopy(join(ui, 'tokens.css'), tmp, 'tokens.css'),
    'relay.css': await hashedCopy(join(ui, 'relay.css'), tmp, 'relay.css'),
    'app.css': await hashedCopy(join(root, 'public', 'app.css'), tmp, 'app.css'),
  };
  // разметка: стили и main — по именам с хэшем, таблица адресов — до main
  let html = await Bun.file(join(root, 'public', 'index.html')).text();
  for (const [name, url] of Object.entries(css)) html = html.replace(`href="/${name}"`, `href="${url}"`);
  html = html.replace('<script type="module" src="/main.js"></script>', `<script>self.__ASSETS__=${JSON.stringify(assets)}</script>\n  <script type="module" src="${assets['main.js']}"></script>`);
  if (!html.includes(assets['main.js'])) throw new Error('index.html: не нашёл <script src="/main.js">');
  await Bun.write(join(tmp, 'index.html'), html);
  // Service Worker — без хэша (адрес регистрации постоянный), со списком оболочки этой сборки
  const shell = [assets['main.js'], ...Object.values(css), assets['shared.worker.js'], assets['dedicated.worker.js'], assets['spoiler.worker.js'], assets['lottie.worker.js'], assets['tlottie.wasm']];
  const sw = await Bun.build({ entrypoints: [join(root, 'src', 'sw.ts')], outdir: tmp, target: 'browser', naming: '[name].[ext]', minify: !isWatch, sourcemap: 'linked', define: { ...define, __SHELL__: JSON.stringify(shell) } });
  if (!sw.success) {
    for (const log of sw.logs) console.error(log);
    if (!isWatch) process.exit(1);
    return;
  }
  // открытые вкладки сверяют свою сборку с этой (update.ts) и предлагают обновиться
  await Bun.write(join(tmp, 'version.json'), JSON.stringify({ build: BUILD }));
  // стикеры-герои: исходники на TS → .tgs (рисует tlottie, WASM — в оболочке сборки)
  await Bun.$`bun ${join(ui, 'stickers', 'build.ts')} ${join(tmp, 'stickers')}`.quiet();
  if (!isWatch) await precompress(tmp);   // в dev сжимает nginx на лету: пересборка остаётся быстрой
  // dev: сжатые копии прежней продакшен-сборки устарели бы (nginx отдал бы старый index.html.gz) — убираем;
  // свои .gz из public (узоры) cp ниже вернёт
  if (isWatch) for (const f of new Bun.Glob('**/*.{gz,br}').scanSync(dist)) if (!HASHED.test(basename(f))) await rm(join(dist, f), { force: true });
  // поверх старой сборки, без удаления папки: сервер ни на миг не остаётся без index.html
  await cp(tmp, dist, { recursive: true, force: true });
  const fresh = [...new Bun.Glob('*').scanSync(tmp)].filter((f) => HASHED.test(f));
  await rm(tmp, { recursive: true, force: true });
  await prune(fresh);
  console.log(`web built ${BUILD}`);
}

/** Убираем файлы с хэшем старше двух последних сборок и прежние имена без хэша. */
async function prune(fresh: string[]): Promise<void> {
  const histFile = Bun.file(join(dist, HISTORY));
  const hist: string[][] = (await histFile.exists()) ? await histFile.json().catch(() => []) : [];
  const same = (a: string[]) => a.length === fresh.length && a.every((f) => fresh.includes(f));
  const keep = [fresh, ...hist.filter((h) => !same(h))].slice(0, 2);   // та же сборка ещё раз — не считается
  await Bun.write(join(dist, HISTORY), JSON.stringify(keep));
  const keepSet = new Set(keep.flat());
  for (const f of new Bun.Glob('*').scanSync(dist)) {
    if ((HASHED.test(f) && !keepSet.has(f)) || LEGACY.includes(f)) await rm(join(dist, f), { force: true });
  }
}

await build();
if (isWatch) {
  let t: ReturnType<typeof setTimeout> | undefined;
  // по одной: две сборки в одной dist.tmp портят друг другу файлы, а prune может стереть свежие
  let running: Promise<void> | null = null, queued = false;
  const rebuild = () => {
    if (running) { queued = true; return; }
    running = build().catch(console.error).finally(() => { running = null; if (queued) { queued = false; rebuild(); } });
  };
  const again = (_e: string, file: string | null) => {
    if (file && /(^|\/)tokens\.css$/.test(file)) return; // результат build-tokens, а не исходник
    clearTimeout(t); t = setTimeout(rebuild, 150);
  };
  for (const dir of [join(root, 'src'), join(root, 'public'), join(ui), join(root, '..', '..', 'packages', 'sync-engine', 'src')]) fsWatch(dir, { recursive: true }, again);
}
