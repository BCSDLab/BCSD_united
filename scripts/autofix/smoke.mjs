import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { jsonFile } from './common.mjs';
import { API_ORIGIN, delay, readJsonResponse, startLocalApi, startProcess, stopProcess } from './local-api.mjs';
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
if (!changed.length || changed.some((file) => !visited.has(resolve('/work', file.path))))
  throw new Error('Changed source is not reachable from the event route; manual smoke required');

const deployPath = resolve('apps/web/.wrangler/deploy/config.json');
const deployment = await jsonFile(deployPath);
const configPath = resolve(dirname(deployPath), deployment.configPath);
if (!configPath.startsWith(`${resolve('apps/web/dist')}${sep}`))
  throw new Error('Vite preview must use the locally built Worker configuration');
const worker = await jsonFile(configPath);
if (
  worker.name !== 'koin-web' ||
  worker.vars?.KOIN_ENVIRONMENT !== 'main' ||
  worker.vars?.KOIN_API_ORIGIN !== 'https://koin-api.bcsdlab.workers.dev' ||
  !worker.services?.some(
    (binding) => binding.binding === 'KOIN_API' && binding.service === 'koin-api' && !binding.remote,
  ) ||
  deployment.auxiliaryWorkers?.length
)
  throw new Error('Offline smoke requires the built main Worker with its local koin-api service binding');
function assertLocalBindings(value) {
  if (!value || typeof value !== 'object') return;
  if (value.remote === true) throw new Error('Remote bindings are forbidden in offline verification');
  for (const child of Object.values(value)) assertLocalBindings(child);
}
assertLocalBindings(worker);

const api = await startLocalApi();
let server;
let browser;
let socket;
let browserProfile;
try {
  const categories = await readJsonResponse(`${API_ORIGIN}/shops/categories`);
  if (!Array.isArray(categories.shop_categories) || categories.count !== categories.shop_categories.length)
    throw new Error('Local D1 categories handler returned an unexpected response');
  for (let attempt = 0; attempt < 20 && api.requestCount() === 0; attempt += 1) await delay(100);
  if (api.requestCount() === 0) throw new Error('Local API request evidence is unavailable');
  browserProfile = await mkdtemp(join(tmpdir(), 'autofix-browser-'));
  server = startProcess('pnpm', ['preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], api.env);
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
    api.env,
  );
  async function ready(url) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      server.assertRunning();
      browser.assertRunning();
      api.assertHealthy();
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
  const beforeSsr = api.requestCount();
  const document = await fetch(`http://127.0.0.1:4173${route}`, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const html = await document.text();
  if (!document.ok || !document.headers.get('content-type')?.includes('text/html') || !html.trim())
    throw new Error('Event route SSR did not return a successful HTML document');
  for (let attempt = 0; attempt < 20 && api.requestCount() === beforeSsr; attempt += 1) await delay(100);
  if (api.requestCount() === beforeSsr)
    throw new Error('Event route did not exercise the real local API during SSR; manual reproduction required');
  api.assertHealthy();
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
  api.assertHealthy();
  process.stdout.write(
    `Real local API/D1 smoke passed: SSR ${route}, browser ${route}, gateway /api/shops/categories\n`,
  );
} catch (error) {
  if (server) process.stderr.write(server.log.slice(-16000));
  throw error;
} finally {
  socket?.close();
  await Promise.all([stopProcess(server?.child), stopProcess(browser?.child)]);
  await Promise.all([api.cleanup(), browserProfile ? rm(browserProfile, { recursive: true, force: true }) : undefined]);
}
