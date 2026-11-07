// Проверка выката в настоящем браузере (headless Chromium, Playwright) — deploy.yml после deploy.sh; провал — откат.
//   node tools/ci/browser-smoke.mjs https://denigram.site <ожидаемый sha>
// Что проверяем: /version.json — эта сборка; /health — ok; /ready — 200 (если сервер его уже отдаёт); страница
// открывается, оболочка приложения (#app) отрисовалась, Service Worker зарегистрирован и активен, в консоли нет ошибок.
// «Не вошёл» — нормальное состояние для чистого браузера: ответы 401/403 API — не ошибка, 5xx — ошибка.
// Для проверки на своей машине: SMOKE_RESOLVE="MAP relay.test 127.0.0.1:18443" SMOKE_INSECURE=1 (свой CA).
import { chromium } from 'playwright';

const [url, expectBuild] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/ci/browser-smoke.mjs <https://host> [build sha]'); process.exit(2); }
const problems = [];
const fail = (m) => { problems.push(m); console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

const insecure = process.env.SMOKE_INSECURE === '1';
// Service Worker на недоверенном сертификате Chromium не регистрирует и с ignoreHTTPSErrors — нужен флаг запуска
const args = [...(process.env.SMOKE_RESOLVE ? [`--host-resolver-rules=${process.env.SMOKE_RESOLVE}`] : []), ...(insecure ? ['--ignore-certificate-errors'] : [])];
const browser = await chromium.launch({ args });
const context = await browser.newContext({ ignoreHTTPSErrors: insecure, serviceWorkers: 'allow' });
const page = await context.newPage();

const consoleErrors = [];
// адреса с 401/403 и наша же проба /ready (404, пока сервер её не отдаёт): «Failed to load resource» — не ошибка
const expectedStatus = new Set([new URL('/ready', url).href]);
page.on('response', (r) => { if (r.status() === 401 || r.status() === 403) expectedStatus.add(r.url()); if (r.status() >= 500) fail(`HTTP ${r.status()} ${r.url()}`); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = m.location()?.url ?? '';
  if (/Failed to load resource/.test(m.text()) && expectedStatus.has(loc)) return;
  consoleErrors.push(`${m.text()}${loc ? ` (${loc})` : ''}`);
});
page.on('pageerror', (e) => consoleErrors.push(`uncaught: ${e.message}`));

// запросы — из страницы (тот же адрес, сеть и сертификат, что у пользователя), без кэша
const get = (path) => page.evaluate(async (p) => {
  const r = await fetch(p, { cache: 'no-store', credentials: 'omit' });
  return { status: r.status, text: await r.text() };
}, path);

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  const v = await get('/version.json');
  const build = v.status === 200 ? JSON.parse(v.text).build : null;
  if (expectBuild && build !== expectBuild) fail(`/version.json: build ${build}, expected ${expectBuild}`); else ok(`/version.json: ${build}`);

  const h = await get('/health');
  if (h.status === 200 && /"ok":\s*true/.test(h.text)) ok('/health'); else fail(`/health: ${h.status} ${h.text.slice(0, 100)}`);
  const r = await get('/ready');
  if (r.status === 404) ok('/ready: not served by this build — skipped');
  else if (r.status === 200) ok('/ready'); else fail(`/ready: ${r.status} ${r.text.slice(0, 200)}`);

  await page.waitForFunction(() => (document.getElementById('app')?.childElementCount ?? 0) > 0, null, { timeout: 20_000 })
    .then(() => ok('app shell rendered (#app)'), () => fail('app shell did not render: #app is empty after 20 s'));
  const sw = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then((reg) => !!reg.active),
    new Promise((res) => setTimeout(() => res(false), 15_000)),
  ]));
  if (sw) ok('service worker active'); else fail('service worker did not become active in 15 s');
  await page.waitForTimeout(2_000);   // поздние ошибки после первого кадра
} catch (e) {
  fail(`smoke crashed: ${e.message}`);
} finally {
  for (const e of consoleErrors) fail(`console: ${e}`);
  await browser.close();
}

if (problems.length) { console.log(`\nbrowser smoke FAILED (${problems.length})`); process.exit(1); }
console.log('\nbrowser smoke ok');
