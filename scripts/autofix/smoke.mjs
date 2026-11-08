import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { jsonFile } from './common.mjs';
import { delay, migrateWebApi, readJsonResponse, startProcess, stopProcess } from './local-api.mjs';
import { applicationGraph, matchesRoute, sourceFiles, webSmokeRoute } from './source-graph.mjs';

const graph = applicationGraph('web');
const context = await jsonFile('/input/context.json');
const manifest = await jsonFile('/patch/patch.json');
const route = webSmokeRoute(context, process.env.AUTOFIX_OFFLINE_STANDALONE === '1');
const roots = [];
let matched = false;
for (const file of await sourceFiles(`${graph.root}/src/routes`)) {
  const source = await readFile(file, 'utf8');
  const id = /createFileRoute\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)?.[1];
  if (id && matchesRoute(id, route, 'web')) {
    roots.push(file);
    matched = true;
  }
  if (file.endsWith('/__root.tsx')) roots.push(file);
}
if (!matched) throw new Error('Canonical event URL has no determinable file route; manual smoke required');
const visited = await graph.dependencies(roots);
const changed = manifest.files.filter((file) => file.path.startsWith('apps/web/src/'));
if (
  process.env.AUTOFIX_OFFLINE_STANDALONE !== '1' &&
  (!changed.length || changed.some((file) => !visited.has(resolve('/work', file.path))))
)
  throw new Error('Changed source is not reachable from the event route; manual smoke required');

// Either the legacy Worker API origin or the Java KOIN_API_V2 origin is an
// accepted production target; offline verification still requires the local
// koin-api auxiliary Worker to be bound in place of it.
const PRODUCTION_API_ORIGINS = ['https://koin-api.bcsdlab.workers.dev', 'https://api.koreatech.in'];
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const deployPath = resolve('apps/web/.wrangler/deploy/config.json');
const deployment = await jsonFile(deployPath);
const configPath = resolve(dirname(deployPath), deployment.configPath);
if (!configPath.startsWith(`${resolve('apps/web/dist')}${sep}`))
  throw new Error('Vite preview must use the locally built Worker configuration');
const worker = await jsonFile(configPath);
const auxiliary = deployment.auxiliaryWorkers;
if (
  worker.name !== 'koin-web' ||
  worker.vars?.KOIN_ENVIRONMENT !== 'main' ||
  !PRODUCTION_API_ORIGINS.includes(worker.vars?.KOIN_API_ORIGIN) ||
  !worker.services?.some(
    (binding) => binding.binding === 'KOIN_API' && binding.service === 'koin-api' && !binding.remote,
  ) ||
  !Array.isArray(auxiliary) ||
  auxiliary.length !== 1
)
  throw new Error('Offline smoke requires the built web Worker and one local koin-api auxiliary Worker');
const apiConfigPath = resolve(dirname(deployPath), auxiliary[0].configPath);
if (!apiConfigPath.startsWith(`${resolve('apps/web/dist')}${sep}`))
  throw new Error('Auxiliary Worker must be the locally built API');
const apiWorker = await jsonFile(apiConfigPath);
if (
  apiWorker.name !== 'koin-api' ||
  !apiWorker.d1_databases?.some((binding) => binding.binding === 'DB' && !binding.remote) ||
  !apiWorker.r2_buckets?.some((binding) => binding.binding === 'FILES' && !binding.remote)
)
  throw new Error('Local API auxiliary Worker lacks its D1/R2 bindings');
function assertLocalBindings(value) {
  if (!value || typeof value !== 'object') return;
  if (value.remote === true) throw new Error('Remote bindings are forbidden in offline verification');
  for (const child of Object.values(value)) assertLocalBindings(child);
}
assertLocalBindings(worker);
assertLocalBindings(apiWorker);

function requestCount(log) {
  return [...log.matchAll(/AUTOFIX_API_REQUEST (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*) \d{3}\b/g)].filter(
    (match) => match[1] !== '/health',
  ).length;
}
function hasUnexpectedApiError(log, { weatherUnavailable = false, coopshopUnavailable = false } = {}) {
  return [...log.matchAll(/AUTOFIX_API_REQUEST (\S+) (\/\S*) ([45]\d{2})\b/g)].some(
    ([, method, path, status]) =>
      !(
        method === 'GET' &&
        ((weatherUnavailable && path === '/weather' && status === '503') ||
          (coopshopUnavailable && path === '/coopshop/1' && status === '404'))
      ),
  );
}
function assertApiHealthy(log, allowed) {
  if (!log.includes('AUTOFIX_API_REQUEST')) throw new Error('Local auxiliary API request evidence is unavailable');
  if (hasUnexpectedApiError(log, allowed)) throw new Error('Local auxiliary API returned an HTTP error');
}
// The offline home route has no weather provider or cafeteria metadata, and both SSR and the
// client request them. Tolerate exactly those responses until the final check, which requires
// their explicit API codes and unavailable UI states.
const homeUnavailable = { weatherUnavailable: route === '/', coopshopUnavailable: route === '/' };

await migrateWebApi();
let server;
let browser;
let socket;
let mobileDiagnostics;
let browserProfile;
try {
  browserProfile = await mkdtemp(join(tmpdir(), 'autofix-browser-'));
  server = startProcess('pnpm', ['preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    ...process.env,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
  });
  browser = startProcess(
    process.env.CHROME_BIN ?? '/usr/bin/chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      `--user-data-dir=${browserProfile}`,
      'about:blank',
    ],
    process.env,
  );
  async function ready(url) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      server.assertRunning();
      browser.assertRunning();
      if (hasUnexpectedApiError(server.log, homeUnavailable))
        throw new Error('Local auxiliary API returned an HTTP error');
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        if (response.ok) return response;
        await response.body?.cancel();
      } catch {}
      await delay(500);
    }
    throw new Error(`Local preview/browser did not become ready: ${url}`);
  }
  async function waitUntil(predicate, description, attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      server.assertRunning();
      browser.assertRunning();
      if (predicate()) return;
      await delay(250);
    }
    throw new Error(`${description} timed out`);
  }
  await ready('http://127.0.0.1:4173/api/health');
  const categories = await readJsonResponse('http://127.0.0.1:4173/api/shops/categories');
  if (!Array.isArray(categories.shop_categories) || categories.count !== categories.shop_categories.length)
    throw new Error('Local D1 categories handler returned an unexpected response');
  for (let attempt = 0; attempt < 20 && requestCount(server.log) === 0; attempt += 1) await delay(100);
  assertApiHealthy(server.log, homeUnavailable);
  const beforeSsr = requestCount(server.log);
  const document = await fetch(`http://127.0.0.1:4173${route}`, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const html = await document.text();
  if (!document.ok || !document.headers.get('content-type')?.includes('text/html') || !html.trim())
    throw new Error('Event route SSR did not return a successful HTML document');
  if (route === '/') await waitUntil(() => requestCount(server.log) > beforeSsr, 'Homepage SSR local API');
  assertApiHealthy(server.log, homeUnavailable);
  const tabs = await (await ready('http://127.0.0.1:9222/json/list')).json();
  const tab = tabs.find((entry) => entry.type === 'page');
  if (!tab) throw new Error('Chromium page unavailable');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser connection timed out')), 15000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Browser connection failed'));
      },
      { once: true },
    );
  });
  let sequence = 0;
  const pending = new Map();
  const failures = [];
  const inFlightRequests = new Map();
  let loaded = false;
  let navigatingBlank = false;
  let unavailableWeatherResponse = false;
  let unavailableCoopshopResponse = false;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const handler = pending.get(message.id);
      if (handler) {
        pending.delete(message.id);
        if (message.error) handler.reject(new Error('Browser protocol error'));
        else handler.resolve(message.result);
      }
    }
    if (
      message.method === 'Network.requestWillBeSent' &&
      ['Document', 'Script', 'Fetch', 'XHR'].includes(message.params.type)
    ) {
      const url = new URL(message.params.request.url);
      inFlightRequests.set(message.params.requestId, {
        type: message.params.type,
        path: url.origin === 'http://127.0.0.1:4173' ? url.pathname : '<external>',
      });
    }
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed')
      inFlightRequests.delete(message.params.requestId);
    if (message.method === 'Page.loadEventFired') loaded = true;
    if (message.method === 'Runtime.exceptionThrown') failures.push('Unhandled browser exception');
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ') ?? '';
      if (message.params.type === 'error') failures.push('Browser console.error');
      if (
        ['warning', 'error'].includes(message.params.type) &&
        /hydration failed|didn.t match|text content does not match|error while hydrating|Minified React error #4(?:1[89]|2[1-5])/i.test(
          text,
        )
      )
        failures.push('React hydration mismatch');
    }
    if (message.method === 'Network.requestWillBeSent' && ['Document', 'Fetch', 'XHR'].includes(message.params.type)) {
      const url = new URL(message.params.request.url);
      if (url.origin !== 'http://127.0.0.1:4173' && !(navigatingBlank && url.href === 'about:blank'))
        failures.push(`Route requires an external request: ${url.origin}${url.pathname}`);
    }
    if (
      message.method === 'Network.loadingFailed' &&
      ['Document', 'Script', 'Fetch', 'XHR'].includes(message.params.type)
    )
      failures.push(`Browser ${message.params.type} request failed`);
    if (
      message.method === 'Network.responseReceived' &&
      ['Document', 'Script', 'Fetch', 'XHR'].includes(message.params.type) &&
      message.params.response.status >= 400
    ) {
      const response = message.params.response;
      const path = new URL(response.url).pathname;
      if (route === '/' && ['Fetch', 'XHR'].includes(message.params.type)) {
        if (response.status === 503 && path === '/api/weather') unavailableWeatherResponse = true;
        else if (response.status === 404 && path === '/api/coopshop/1') unavailableCoopshopResponse = true;
        else failures.push(`Browser ${message.params.type} HTTP ${response.status}`);
      } else failures.push(`Browser ${message.params.type} HTTP ${response.status}`);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolveCommand, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Browser command timed out'));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:4173${route}` });
  await waitUntil(() => loaded, 'Desktop route load');
  const gateway = await send('Runtime.evaluate', {
    expression:
      'fetch("/api/shops/categories", {redirect:"error"}).then(async response => ({status:response.status, type:response.headers.get("content-type"), body:await response.json()}))',
    awaitPromise: true,
    returnByValue: true,
  });
  const gatewayValue = gateway.result?.value;
  if (
    gateway.exceptionDetails ||
    gatewayValue?.status !== 200 ||
    !gatewayValue?.type?.includes('application/json') ||
    !isDeepStrictEqual(gatewayValue.body, categories)
  )
    failures.push('Browser gateway did not return the real local D1 categories response');
  await waitUntil(() => inFlightRequests.size === 0, 'Desktop route requests');
  const dom = await send('Runtime.evaluate', {
    expression:
      '({ path: location.pathname, text: document.body.innerText, elements: document.body.querySelectorAll("*").length })',
    returnByValue: true,
  });
  const value = dom.result?.value;
  if (
    !value ||
    value.path.replace(/\/$/, '') !== route.replace(/\/$/, '') ||
    value.elements < 3 ||
    !value.text?.trim() ||
    /something went wrong|internal server error|페이지를 불러오지 못했습니다/i.test(value.text)
  )
    failures.push('Route rendered no usable application or redirected');
  server.assertRunning();
  browser.assertRunning();
  if (/\[ERROR\]|uncaught|unhandled rejection/i.test(server.log)) failures.push('Web Worker emitted runtime errors');
  if (failures.length) throw new Error([...new Set(failures)].join('; '));
  assertApiHealthy(server.log, homeUnavailable);
  process.stdout.write(
    `Real local API/D1 smoke passed: SSR ${route}, browser ${route}, gateway /api/shops/categories\n`,
  );
  // Leave the desktop document before resizing: its client media-query
  // subscriptions must not spawn requests that survive a reload.
  navigatingBlank = true;
  loaded = false;
  await send('Page.navigate', { url: 'about:blank' });
  await waitUntil(() => loaded && inFlightRequests.size === 0, 'Desktop document cleanup');
  navigatingBlank = false;
  const beforeMobile = requestCount(server.log);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setUserAgentOverride', {
    userAgent: MOBILE_USER_AGENT,
    platform: 'Android',
  });
  const mobileDocument = await fetch(`http://127.0.0.1:4173${route}`, {
    headers: { 'user-agent': MOBILE_USER_AGENT },
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const mobileHtml = await mobileDocument.text();
  if (!mobileDocument.ok || !mobileDocument.headers.get('content-type')?.includes('text/html') || !mobileHtml.trim())
    throw new Error('Mobile event route SSR did not return a successful HTML document');
  if (route === '/') await waitUntil(() => requestCount(server.log) > beforeMobile, 'Mobile homepage SSR local API');
  loaded = false;
  await send('Page.navigate', { url: `http://127.0.0.1:4173${route}` });
  await waitUntil(() => loaded, 'Mobile route load');
  await waitUntil(() => inFlightRequests.size === 0, 'Mobile route requests');
  let mobile;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dom = await send('Runtime.evaluate', {
      expression:
        '(() => { const heading = document.getElementById("home-greeting-title"); const mealHeading = document.getElementById("today-menu-title"); const mealSection = mealHeading?.closest("section"); const mealList = Array.from(mealSection?.querySelectorAll("[aria-label]") ?? []).find((node) => node.getAttribute("aria-label") === "오늘의 식단 목록"); return { path: location.pathname, width: innerWidth, mobile: matchMedia("(max-width: 600px)").matches, text: document.body.innerText, elements: document.body.querySelectorAll("*").length, greeting: heading?.getClientRects().length ? heading.innerText : null, meal: mealList ? { count: mealList.querySelectorAll("h3").length, text: mealSection.innerText } : null }; })()',
      returnByValue: true,
    });
    if (dom.exceptionDetails) {
      failures.push('Mobile DOM evaluation failed');
      break;
    }
    mobile = dom.result?.value;
    if (route !== '/' || (mobile?.greeting?.trim() && mobile?.meal && !mobile.text?.includes('날씨 확인 중'))) break;
    await delay(250);
  }
  if (
    !mobile ||
    mobile.path.replace(/\/$/, '') !== route.replace(/\/$/, '') ||
    mobile.width !== 390 ||
    !mobile.mobile ||
    mobile.elements < 3 ||
    !mobile.text?.trim() ||
    /something went wrong|internal server error|페이지를 불러오지 못했습니다/i.test(mobile.text) ||
    (route === '/' && (!mobile.greeting?.trim() || !mobile.meal?.text?.includes('오늘의 식단')))
  )
    failures.push('Mobile route did not render a usable 390px application');

  const mobileGateway = await send('Runtime.evaluate', {
    expression:
      'fetch("/api/shops/categories", {redirect:"error"}).then(async response => ({status:response.status, type:response.headers.get("content-type"), body:await response.json()}))',
    awaitPromise: true,
    returnByValue: true,
  });
  const mobileGatewayValue = mobileGateway.result?.value;
  if (
    mobileGateway.exceptionDetails ||
    mobileGatewayValue?.status !== 200 ||
    !mobileGatewayValue?.type?.includes('application/json') ||
    !isDeepStrictEqual(mobileGatewayValue.body, categories)
  )
    failures.push('Mobile gateway did not return the real local D1 categories response');

  const weatherUnavailable =
    route === '/' && (unavailableWeatherResponse || /AUTOFIX_API_REQUEST GET \/weather 503\b/.test(server.log));
  if (weatherUnavailable) {
    const weather = await send('Runtime.evaluate', {
      expression:
        'fetch("/api/weather", {redirect:"error"}).then(async response => ({status:response.status, code:(await response.json()).code}))',
      awaitPromise: true,
      returnByValue: true,
    });
    if (
      weather.exceptionDetails ||
      weather.result?.value?.status !== 503 ||
      weather.result.value.code !== 'CONFIGURATION_ERROR' ||
      !mobile?.text?.includes('날씨 정보 제공 불가')
    )
      failures.push('Missing local weather provider did not render an explicit unavailable state');
  }
  const coopshopUnavailable =
    route === '/' && (unavailableCoopshopResponse || /AUTOFIX_API_REQUEST GET \/coopshop\/1 404\b/.test(server.log));
  if (coopshopUnavailable) {
    const coopshop = await send('Runtime.evaluate', {
      expression:
        'fetch("/api/coopshop/1", {redirect:"error"}).then(async response => ({status:response.status, code:(await response.json()).code}))',
      awaitPromise: true,
      returnByValue: true,
    });
    if (
      coopshop.exceptionDetails ||
      coopshop.result?.value?.status !== 404 ||
      coopshop.result.value.code !== 'NOT_FOUND_DATA' ||
      !mobile?.meal ||
      (mobile.meal.count
        ? !mobile.meal.text.includes('운영시간 정보 제공 불가')
        : !mobile.meal.text.includes('오늘은 식단이 없어요'))
    )
      failures.push('Missing local cafeteria metadata did not preserve the real meal widget');
  }
  server.assertRunning();
  browser.assertRunning();
  if (/\[ERROR\]|uncaught|unhandled rejection/i.test(server.log)) failures.push('Web Worker emitted runtime errors');
  assertApiHealthy(server.log, { weatherUnavailable, coopshopUnavailable });
  if (failures.length) {
    mobileDiagnostics = JSON.stringify({
      path: mobile?.path,
      viewport: mobile?.width,
      mobileMedia: mobile?.mobile,
      greetingVisible: Boolean(mobile?.greeting?.trim()),
      mealVisible: Boolean(mobile?.meal),
      mealCount: mobile?.meal?.count,
      noMealsLabel: Boolean(mobile?.meal?.text?.includes('오늘은 식단이 없어요')),
      hoursUnavailableLabel: Boolean(mobile?.meal?.text?.includes('운영시간 정보 제공 불가')),
      weatherUnavailableLabel: Boolean(mobile?.text?.includes('날씨 정보 제공 불가')),
      weatherPendingLabel: Boolean(mobile?.text?.includes('날씨 확인 중')),
      routeErrorLabel: Boolean(mobile?.text?.includes('페이지를 불러오지 못했습니다')),
      inFlight: [...inFlightRequests.values()].slice(0, 12),
    });
    throw new Error([...new Set(failures)].join('; '));
  }
  process.stdout.write(`Mobile local API/D1 smoke passed: ${route} at 390px, gateway /api/shops/categories\n`);
} catch (error) {
  if (server) process.stderr.write(server.log.slice(-8000));
  if (mobileDiagnostics) process.stderr.write(`Mobile smoke diagnostics ${mobileDiagnostics}\n`);
  throw error;
} finally {
  socket?.close();
  await Promise.all([stopProcess(server?.child), stopProcess(browser?.child)]);
  if (browserProfile) await rm(browserProfile, { recursive: true, force: true });
}
