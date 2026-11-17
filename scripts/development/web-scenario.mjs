import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEWPORT = { width: 1440, height: 900 };
const MEALS = [
  { type: 'BREAKFAST', label: '아침' },
  { type: 'LUNCH', label: '점심' },
  { type: 'DINNER', label: '저녁' },
];
const SCENARIOS = {
  'dining-view': ['dining-view.png', 'dining-view-meals.png'],
  'dining-meal-change': ['dining-meal-change-before.png', 'dining-meal-change-after.png'],
};
const SERVER_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 8 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

/** 조건이 참이 될 때까지 재시도한다. 페이지 재로드로 실행 컨텍스트가 사라진 경우도 재시도 대상이다. */
async function waitFor(description, probe, timeoutMs = STEP_TIMEOUT_MS) {
  console.error(`[web-scenario] waiting for ${description}`);
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      last = undefined;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  fail(`Timed out after ${timeoutMs}ms waiting for ${description}${last ? `: ${last.message}` : ''}`);
}

/** 프로세스 트리 전체를 종료한다. Windows에서는 손자 프로세스(workerd, Chrome renderer)가 남지 않도록 taskkill을 쓴다. */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true });
  } else if (!exited(child)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Windows의 Chrome은 실행 직후 다른 PID로 다시 떠서 spawn한 PID로는 종료할 수 없다.
 * 이 실행 전용 임시 프로필 경로를 명령줄에 가진 chrome.exe만 찾아 종료한다.
 */
function killChrome(chrome, profileDir) {
  if (process.platform !== 'win32') return killTree(chrome);
  const query = `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profileDir)}*' }).ProcessId`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', query], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    const pids = (found.stdout ?? '').split(/\s+/).filter((pid) => /^\d+$/.test(pid));
    if (found.status === 0 && pids.length === 0) return undefined;
    for (const pid of pids) killTree({ pid });
  }
  return fail(`Chrome processes for ${profileDir} are still running`);
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Chrome DevTools socket')), {
      once: true,
    });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(`${handler.method}: ${message.error.message}`));
    else handler.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const handler of pending.values()) handler.reject(new Error(`${handler.method}: DevTools socket closed`));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

function createPage(cdp) {
  async function evaluate(expression) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) fail(`Page evaluation failed: ${exceptionDetails.exception?.description ?? expression}`);
    return result.value;
  }

  /** DOM을 직접 바꾸지 않고, 요소 중심 좌표에 실제 마우스 입력 이벤트를 보낸다. */
  async function click(description, locator) {
    const point = await waitFor(`${description} to be clickable`, () =>
      evaluate(`(() => {
        const element = (${locator})();
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === element || element.contains(hit)) ? { x, y } : null;
      })()`),
    );
    const mouse = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await cdp.send('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased', buttons: 0 });
    return point;
  }

  /**
   * 전체 페이지 캡처. Chrome이 캡처 도중 viewport를 잠깐 줄여 PC 화면이 다시 마운트되고 열린 끼니 목록이 닫히므로,
   * 열린 상태를 남겨야 할 때는 screenshotViewport를 쓴다.
   */
  async function screenshotFullPage(filename) {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
    });
    await writeFile(filename, Buffer.from(data, 'base64'));
  }

  async function screenshotViewport(filename) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(filename, Buffer.from(data, 'base64'));
  }

  return { evaluate, click, screenshotFullPage, screenshotViewport };
}

// PC 식단 화면의 끼니 선택 컨트롤: `#dropdown-button`과, 열렸을 때 같은 wrapper 안에 생기는 `{끼니}식단` 버튼들.
const BUTTON = `() => document.getElementById('dropdown-button')`;
const OPTIONS = `() => [...(document.getElementById('dropdown-button')?.parentElement?.querySelectorAll('button') ?? [])]
  .filter((button) => button.id !== 'dropdown-button')`;
const option = (label) => `() => (${OPTIONS})().find((button) => button.textContent.trim() === '${label}식단')`;
const STATE = `(() => ({
  url: location.href,
  type: new URLSearchParams(location.search).get('type'),
  selected: (${BUTTON})()?.textContent.trim() ?? null,
  options: (${OPTIONS})().map((button) => button.textContent.trim()),
  hydrated: Object.keys((${BUTTON})() ?? {}).some((key) => key.startsWith('__reactProps$')),
  places: [...document.querySelectorAll('[class*="header__place"]')].map((node) => node.textContent.trim()),
}))()`;

async function openCafeteria(cdp, page, origin) {
  const url = `${origin}/cafeteria`;
  const hydrated = () =>
    waitFor('the cafeteria page to hydrate', async () => {
      const state = await page.evaluate(STATE);
      return state.hydrated && state.url.startsWith(url) ? state : null;
    });
  // 첫 진입은 Vite 의존성 최적화로 페이지가 스스로 재로드될 수 있어, 한 번 데운 뒤 다시 진입한 상태를 검증한다.
  await cdp.send('Page.navigate', { url });
  await hydrated();
  await sleep(2000);
  await cdp.send('Page.navigate', { url });
  const state = await hydrated();
  const meal = MEALS.find(({ label }) => state.selected === `${label}식단`);
  if (!meal) fail(`Meal selector shows an unexpected label: ${JSON.stringify(state.selected)}`);
  return { state, meal };
}

async function diningView({ cdp, page, origin, outDir }) {
  const { meal } = await openCafeteria(cdp, page, origin);
  await page.screenshotFullPage(path.join(outDir, 'dining-view.png'));
  await page.click('the meal selector', BUTTON);
  const expected = MEALS.map(({ label }) => `${label}식단`);
  const rendered = async () => {
    const current = await page.evaluate(STATE);
    return expected.every((label) => current.options.includes(label)) ? current : null;
  };
  await waitFor('the meal labels 아침·점심·저녁 to be rendered', rendered);
  await page.screenshotViewport(path.join(outDir, 'dining-view-meals.png'));
  const state = await rendered();
  if (!state) fail('The meal labels were no longer rendered when the screenshot was taken');
  return {
    assertions: [
      'GET /cafeteria hydrated at a 1440x900 desktop viewport',
      `meal selector shows the current meal: ${meal.label}식단`,
      `opening the selector with a real mouse click renders ${expected.join(', ')}`,
    ],
    state,
  };
}

async function diningMealChange({ cdp, page, origin, outDir }) {
  const { state: before, meal: from } = await openCafeteria(cdp, page, origin);
  const to = MEALS.find(({ type }) => type !== from.type);
  await page.screenshotFullPage(path.join(outDir, 'dining-meal-change-before.png'));
  await page.click('the meal selector', BUTTON);
  await page.click(`the ${to.label}식단 option`, option(to.label));
  const after = await waitFor(`the page to switch from ${from.label} to ${to.label}`, async () => {
    const current = await page.evaluate(STATE);
    return current.type === to.type && current.selected === `${to.label}식단` && current.options.length === 0
      ? current
      : null;
  });
  await page.screenshotFullPage(path.join(outDir, 'dining-meal-change-after.png'));
  return {
    assertions: [
      `meal selector initially showed ${from.label}식단`,
      `real mouse clicks on the selector and on the ${to.label}식단 option`,
      `URL query became type=${to.type}`,
      `meal selector now shows ${to.label}식단 and the option list is closed`,
    ],
    state: { before, after },
  };
}

async function startServer(webDir, port) {
  const vite = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(process.execPath, [vite, '--port', String(port), '--strictPort'], {
    cwd: webDir,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 2, 2],
  });
  server.once('error', () => {});
  return server;
}

async function waitForServer(server, origin) {
  await waitFor(
    `the web dev server at ${origin}`,
    async () => {
      if (exited(server)) return true;
      const response = await fetch(`${origin}/cafeteria`, { signal: AbortSignal.timeout(60_000) });
      await response.arrayBuffer();
      if (!response.ok) fail(`GET /cafeteria answered ${response.status}`);
      return true;
    },
    SERVER_TIMEOUT_MS,
  );
  if (exited(server)) fail(`The web dev server exited early with code ${server.exitCode}`);
}

async function startChrome(profileDir, debugPort) {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ],
    { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' },
  );
  chrome.once('error', () => {});
  return chrome;
}

async function attach(debugPort) {
  const target = await waitFor('Chrome to expose a page on its remote debugging port', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(5000) });
    return (await response.json()).find(({ type, url }) => type === 'page' && url === 'about:blank');
  });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

async function main() {
  const { values } = parseArgs({
    options: {
      checkout: { type: 'string' },
      scenario: { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string', default: '3000' },
    },
  });
  const files = SCENARIOS[values.scenario];
  if (!values.checkout || !values.out || !files) {
    fail('Usage: web-scenario.mjs --checkout DIR --scenario dining-view|dining-meal-change --out DIR [--port N]');
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid --port: ${values.port}`);
  const checkout = path.resolve(values.checkout);
  const outDir = path.resolve(checkout, values.out);
  const relativeOut = path.relative(checkout, outDir);
  if (path.isAbsolute(values.out) || relativeOut === '' || relativeOut.startsWith('..') || path.isAbsolute(relativeOut))
    fail('--out must be a relative path inside the checkout');
  // 대상 체크아웃을 더럽히지 않도록, 증거는 git이 무시하는 위치에만 쓴다.
  const ignored = spawnSync('git', ['check-ignore', '-q', relativeOut], {
    cwd: checkout,
    shell: false,
    windowsHide: true,
  });
  if (ignored.status !== 0) fail(`--out is not git-ignored in the checkout: ${relativeOut}`);
  await mkdir(outDir, { recursive: true });
  for (const name of [...files, 'result.json']) await rm(path.join(outDir, name), { force: true });

  const origin = `http://localhost:${port}`;
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'koin-web-scenario-'));
  const startedAt = new Date().toISOString();
  let server;
  let chrome;
  let cdp;
  let timer;
  try {
    const run = async () => {
      server = await startServer(path.join(checkout, 'apps', 'web'), port);
      await waitForServer(server, origin);
      const debugPort = await freePort();
      chrome = await startChrome(profileDir, debugPort);
      cdp = await attach(debugPort);
      const context = { cdp, page: createPage(cdp), origin, outDir };
      return values.scenario === 'dining-view' ? diningView(context) : diningMealChange(context);
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Scenario exceeded the ${TOTAL_TIMEOUT_MS}ms total limit`)),
        TOTAL_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([run(), timeout]);
    const result = {
      scenario: values.scenario,
      passed: true,
      route: '/cafeteria',
      viewport: VIEWPORT,
      startedAt,
      completedAt: new Date().toISOString(),
      screenshots: files,
      ...outcome,
    };
    await writeFile(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearTimeout(timer);
    cdp?.close();
    killTree(server);
    killChrome(chrome, profileDir);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`web-scenario failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
