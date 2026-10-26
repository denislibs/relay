// Сборка клиента в dist: main, Service Worker, два хоста движка, html и стили дизайн-системы.
// Код и стили — с хэшем в имени (кэш навсегда), index.html / sw.js / version.json — без (перепроверяются).
//   bun apps/web/build.ts            — одна сборка
//   bun apps/web/build.ts --watch    — пересборка при изменениях (dev)
import { watch as fsWatch } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { brotliCompressSync, constants as Z, gzipSync } from 'node:zlib';
import { VOICE_WORKLET } from '../../packages/relay-ui/src/media/voiceWorklet.js';

const root = import.meta.dir;
const ui = join(root, '..', '..', 'packages', 'relay-ui');
const engineHosts = join(root, '..', '..', 'packages', 'sync-engine', 'src', 'hosts');
const dist = process.env.WEB_OUT ?? join(root, 'dist');   // WEB_OUT — собрать в другую папку (проверка продакшен-сборки)
const isWatch = process.argv.includes('--watch');

const HASHED = /-[a-z0-9]{8,}\.(js|css|wasm)(\.map|\.gz|\.br)?$/;   // имя с хэшем: кэшируется навсегда (docker/nginx)
const LEGACY = ['main.js', 'main.js.map', 'shared.worker.js', 'shared.worker.js.map', 'dedicated.worker.js', 'dedicated.worker.js.map', 'spoiler.worker.js', 'spoiler.worker.js.map', 'articleEditor.js', 'articleEditor.js.map', 'relay.css', 'tokens.css', 'app.css', 'boot.js'];
const HISTORY = '.assets-history.json';   // файлы двух последних сборок: открытые вкладки прежней ещё догружают свои

/** name.css → name-<хэш>.css; возвращает публичный адрес. */
async function hashedCopy(src: string, dir: string, name: string): Promise<string> {
  return hashedWrite(await Bun.file(src).bytes(), dir, name);
}
async function hashedWrite(body: Uint8Array | string, dir: string, name: string): Promise<string> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const file = name.replace(/\.(css|wasm|js)$/, (ext) => '-' + Bun.hash(bytes).toString(36).padStart(8, '0').slice(0, 10) + ext);
  await Bun.write(join(dir, file), bytes);
  return '/' + file;
}

/** Subresource Integrity: «sha384-…» для атрибута integrity в index.html. */
const sri = async (dir: string, url: string) => 'sha384-' + new Bun.CryptoHasher('sha384').update(await Bun.file(join(dir, url.slice(1))).bytes()).digest('base64');
/** Таблица целостности для Service Worker: адрес файла с хэшем в имени → SHA-256 (base64) его байтов. */
async function integrityTable(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of new Bun.Glob('*.{js,css,wasm}').scanSync(dir)) {
    if (!HASHED.test(f)) continue;
    out['/' + f] = new Bun.CryptoHasher('sha256').update(await Bun.file(join(dir, f)).bytes()).digest('base64');
  }
  return out;
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
    format: 'esm',
    splitting: true,
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
  // чанки (splitting): общий код точек входа и разделы за import() — ui/lazy.tsx (вход, настройки, эмодзи, группы)
  const chunks: string[] = [];
  for (const o of res.outputs) {
    if (o.kind === 'chunk') chunks.push('/' + basename(o.path));
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
  // ворклет записи голосового — файлом (CSP не пускает скрипты из blob:)
  assets['voice.worklet.js'] = await hashedWrite(VOICE_WORKLET, tmp, 'voice.worklet.js');
  // первый скрипт страницы (тема до стилей) + таблица адресов; встроенных скриптов нет — CSP пускает только файлы
  const boot = await hashedWrite(`${await Bun.file(join(root, 'public', 'boot.js')).text()}\nself.__ASSETS__=${JSON.stringify(assets)};\n`, tmp, 'boot.js');
  await rm(join(tmp, 'boot.js'), { force: true });
  // разметка: всё по именам с хэшем и с integrity (SRI) — подменённый по дороге файл браузер не выполнит
  let html = await Bun.file(join(root, 'public', 'index.html')).text();
  for (const [name, url] of Object.entries(css)) html = html.replace(`<link rel="stylesheet" href="/${name}">`, `<link rel="stylesheet" href="${url}" integrity="${await sri(tmp, url)}">`);
  html = html.replace('<script src="/boot.js"></script>', `<script src="${boot}" integrity="${await sri(tmp, boot)}"></script>`);
  // каркас приложения (public/shell.html — первый кадр боковой колонки без данных): виден до выполнения main, если на
  // устройстве уже входили (boot.js → html[data-shell]); main.tsx убирает его, когда колонки приложения проявились
  const shellHtml = (await Bun.file(join(root, 'public', 'shell.html')).text()).trim();
  await rm(join(tmp, 'shell.html'), { force: true });
  html = html.replace('<div id="app" class="rl"></div>', `<div id="shell" class="rl" aria-hidden="true" inert>${shellHtml}</div>\n  <div id="app" class="rl"></div>`);
  if (!html.includes('id="shell"')) throw new Error('index.html: нет места под каркас (#app)');
  // чанки, которые main импортирует статически, — modulepreload рядом с ним: качаются параллельно, а не после разбора main
  const mainCode = await Bun.file(join(tmp, assets['main.js'].slice(1))).text();
  const direct = [...mainCode.matchAll(/(?:^|[;}\s])import\s*(?:[\w${}\s,*]*?from\s*)?"\.\/([\w.-]+\.js)"/g)].map((m) => '/' + m[1]).filter((u) => chunks.includes(u));
  let preload = '';
  for (const url of [...new Set(direct)]) preload += `<link rel="modulepreload" href="${url}" integrity="${await sri(tmp, url)}">\n  `;
  html = html.replace('<script type="module" src="/main.js"></script>', `${preload}<script type="module" src="${assets['main.js']}" integrity="${await sri(tmp, assets['main.js'])}"></script>`);
  for (const url of [boot, assets['main.js'], ...Object.values(css)]) if (!html.includes(`"${url}" integrity=`)) throw new Error(`index.html: нет ${url} с integrity`);
  await Bun.write(join(tmp, 'index.html'), html);
  // Service Worker — без хэша (адрес регистрации постоянный), со списком оболочки этой сборки
  // чанки — все: ленивые разделы (настройки, вход…) должны открываться и без сети
  const shell = [boot, assets['main.js'], ...chunks, ...Object.values(css), assets['shared.worker.js'], assets['dedicated.worker.js'], assets['spoiler.worker.js'], assets['lottie.worker.js'], assets['tlottie.wasm'], assets['voice.worklet.js']];
  // SW сверяет каждый файл с хэшем в имени с этой таблицей: чужие байты (подмена в CDN, кэше, прокси) не выполнятся
  const integrity = await integrityTable(tmp);
  const sw = await Bun.build({ entrypoints: [join(root, 'src', 'sw.ts')], outdir: tmp, target: 'browser', naming: '[name].[ext]', minify: !isWatch, sourcemap: 'linked', define: { ...define, __SHELL__: JSON.stringify(shell), __INTEGRITY__: JSON.stringify(integrity) } });
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
