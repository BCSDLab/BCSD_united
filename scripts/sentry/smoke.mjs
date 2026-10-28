import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonFile } from './common.mjs';
import { startLocalApi, stopProcess } from './local-api.mjs';
import { applicationGraph, matchesRoute, sourceFiles } from './source-graph.mjs';

const graph = applicationGraph('web');
const context = await jsonFile('/input/context.json');
const manifest = await jsonFile('/patch/patch.json');
const route = context.route;
if (typeof route !== 'string' || !/^\/[A-Za-z0-9_/-]*$/.test(route) || route.startsWith('//')) throw new Error('Unsafe smoke path');
const roots = [];
let matched = false;
for (const file of await sourceFiles(`${graph.root}/src/routes`)) {
  const source = await readFile(file, 'utf8');
  const id = /createFileRoute\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)?.[1];
  if (id && matchesRoute(id, route, 'web')) { roots.push(file); matched = true; }
  if (file.endsWith('/__root.tsx')) roots.push(file);
}
if (!matched) throw new Error('Canonical event URL has no determinable file route; manual smoke required');
const visited = await graph.dependencies(roots);
const changed = manifest.files.filter((file) => file.path.startsWith('apps/web/src/'));
if (!changed.length || changed.some((file) => !visited.has(resolve('/work', file.path)))) throw new Error('Changed source is not reachable from the event route; manual smoke required');

const api = await startLocalApi();
const server = spawn('pnpm', ['preview', '--host', '127.0.0.1', '--port', '4173'], { stdio: 'ignore', detached: true });
const browser = spawn(process.env.CHROME_BIN ?? '/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=/tmp/sentry-browser', 'about:blank'], { stdio: 'ignore', detached: true });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function ready(url) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return response; } catch {}
    await delay(500);
  }
  throw new Error('Local preview/browser did not become ready');
}
let socket;
try {
  await ready(`http://127.0.0.1:4173${route}`);
  const tabs = await (await ready('http://127.0.0.1:9222/json/list')).json();
  const tab = tabs.find((entry) => entry.type === 'page');
  if (!tab) throw new Error('Chromium page unavailable');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const failures = [];
  let loaded = false;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); message.error ? handler.reject(new Error('Browser protocol error')) : handler.resolve(message.result); } }
    if (message.method === 'Page.loadEventFired') loaded = true;
    if (message.method === 'Runtime.exceptionThrown') failures.push('Unhandled browser exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') failures.push('Browser console.error');
    if (message.method === 'Network.responseReceived' && message.params.type === 'Document' && message.params.response.status >= 400) failures.push('Document HTTP error');
  });
  const send = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out')); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveCommand(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:4173${route}` });
  for (let attempt = 0; attempt < 60 && !loaded; attempt += 1) await delay(250);
  if (!loaded) throw new Error('Route did not finish loading');
  await delay(3000);
  const dom = await send('Runtime.evaluate', { expression: '({ path: location.pathname, text: document.body.innerText, elements: document.body.querySelectorAll("*").length })', returnByValue: true });
  const value = dom.result?.value;
  if (!value || value.path.replace(/\/$/, '') !== route.replace(/\/$/, '') || value.elements < 3 || !value.text?.trim() || /something went wrong|internal server error/i.test(value.text)) failures.push('Route rendered no usable application or redirected');
  if (failures.length) throw new Error([...new Set(failures)].join('; '));
  api.assertHealthy();
} finally {
  socket?.close();
  for (const child of [server, browser, api.child]) stopProcess(child);
}
