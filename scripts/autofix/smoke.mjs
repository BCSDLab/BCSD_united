import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { jsonFile } from './common.mjs';
import { delay, migrateWebApi, readJsonResponse, startProcess, stopProcess } from './local-api.mjs';
import { applicationGraph, matchesRoute, sourceFiles } from './source-graph.mjs';

const graph = applicationGraph('web');
const context = await jsonFile('/input/context.json');
const manifest = await jsonFile('/patch/patch.json');
const route = context.route;
if (context.app !== 'web' || typeof route !== 'string' || !/^\/[A-Za-z0-9_/-]*$/.test(route) || route.startsWith('//'))
  throw new Error('Unsafe smoke path');
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
  worker.vars?.KOIN_API_ORIGIN !== 'https://koin-api.bcsdlab.workers.dev' ||
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

function assertApiHealthy(log) {
  if (!log.includes('AUTOFIX_API_REQUEST')) throw new Error('Local auxiliary API request evidence is unavailable');
  if (/AUTOFIX_API_REQUEST \S+ \S+ [45]\d{2}\b/i.test(log))
    throw new Error('Local auxiliary API returned an HTTP error');
}

await migrateWebApi();
let server;
let browser;
let socket;
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
      if (/AUTOFIX_API_REQUEST \S+ \S+ [45]\d{2}\b/i.test(server.log))
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
  await ready('http://127.0.0.1:4173/api/health');
  const categories = await readJsonResponse('http://127.0.0.1:4173/api/shops/categories');
  if (!Array.isArray(categories.shop_categories) || categories.count !== categories.shop_categories.length)
    throw new Error('Local D1 categories handler returned an unexpected response');
  for (let attempt = 0; attempt < 20 && requestCount(server.log) === 0; attempt += 1) await delay(100);
  assertApiHealthy(server.log);
  const beforeSsr = requestCount(server.log);
  const document = await fetch(`http://127.0.0.1:4173${route}`, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const html = await document.text();
  if (!document.ok || !document.headers.get('content-type')?.includes('text/html') || !html.trim())
    throw new Error('Event route SSR did not return a successful HTML document');
  for (let attempt = 0; attempt < 20 && requestCount(server.log) === beforeSsr; attempt += 1) await delay(100);
  if (requestCount(server.log) === beforeSsr)
    throw new Error('Event route did not exercise the real local API during SSR; manual reproduction required');
  assertApiHealthy(server.log);
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
  const inFlightRequests = new Set();
  let loaded = false;
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
    )
      inFlightRequests.add(message.params.requestId);
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed')
      inFlightRequests.delete(message.params.requestId);
    if (message.method === 'Page.loadEventFired') loaded = true;
    if (message.method === 'Runtime.exceptionThrown') failures.push('Unhandled browser exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
      failures.push('Browser console.error');
    if (message.method === 'Network.requestWillBeSent' && ['Document', 'Fetch', 'XHR'].includes(message.params.type)) {
      const url = new URL(message.params.request.url);
      if (url.origin !== 'http://127.0.0.1:4173')
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
    )
      failures.push(`Browser ${message.params.type} HTTP ${message.params.response.status}`);
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
  for (let attempt = 0; attempt < 60 && !loaded; attempt += 1) await delay(250);
  if (!loaded) throw new Error('Route did not finish loading');
  await delay(3000);
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
  for (let attempt = 0; attempt < 60 && inFlightRequests.size; attempt += 1) await delay(250);
  if (inFlightRequests.size) failures.push('Browser route still has unfinished application requests');
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
    /something went wrong|internal server error/i.test(value.text)
  )
    failures.push('Route rendered no usable application or redirected');
  server.assertRunning();
  browser.assertRunning();
  if (/\[ERROR\]|uncaught|unhandled rejection/i.test(server.log)) failures.push('Web Worker emitted runtime errors');
  if (failures.length) throw new Error([...new Set(failures)].join('; '));
  assertApiHealthy(server.log);
  process.stdout.write(
    `Real local API/D1 smoke passed: SSR ${route}, browser ${route}, gateway /api/shops/categories\n`,
  );
} catch (error) {
  if (server) process.stderr.write(server.log.slice(-16000));
  throw error;
} finally {
  socket?.close();
  await Promise.all([stopProcess(server?.child), stopProcess(browser?.child)]);
  if (browserProfile) await rm(browserProfile, { recursive: true, force: true });
}
