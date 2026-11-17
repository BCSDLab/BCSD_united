import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { INVENTORY, validateInventory } from './web-suite.mjs';

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
  'dining-date-change': ['dining-date-change-before.png', 'dining-date-change-after.png'],
};
const WEEK_DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 8 * 60_000;
// 화면 순회: 화면마다 데스크톱과 모바일에서 한 번씩 연다. 모바일은 서버가 UA로 기기를 판정하므로 UA도 함께 바꾼다.
const SCREEN_VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SWEEP_TIMEOUT_MS = 55 * 60_000;
const IDLE_MS = 1000;
const IDLE_TIMEOUT_MS = 15_000;
const MAX_RELOADS = 2;
const MAX_CAPTURE_HEIGHT = 6000;
const MAX_MESSAGE_LENGTH = 500;

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
  const listeners = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Chrome DevTools socket')), {
      once: true,
    });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
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
    /** `Network.*` 같은 DevTools 이벤트를 구독한다. */
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
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
   * 열린 상태를 남겨야 할 때는 screenshotViewport를 쓴다. maxHeight를 주면 그 높이까지만 남긴다.
   */
  async function screenshotFullPage(filename, maxHeight = Infinity) {
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: cssContentSize.width,
        height: Math.min(cssContentSize.height, maxHeight),
        scale: 1,
      },
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

// PC 식단 화면의 날짜 선택 컨트롤: 일요일부터 토요일까지 한 주를 나열한 `week__one-day` 버튼 7개.
// 선택된 날짜는 `week__one-day--selected` 클래스와 URL의 `date=YYYY-MM-DD`로 드러난다.
const DAYS = `() => [...document.querySelectorAll('button[class*="week__one-day"]')]`;
const day = (index) => `() => (${DAYS})()[${index}]`;
// 식단 영역: 안내 문구(`pc-menu-blocks__caution`)의 부모. 첫 자식이 식단 블록을 담는 상자이고,
// 이 화면에는 별도의 빈 상태 문구가 없어 식단이 없는 날은 상자가 비고 안내 문구만 남는다.
const DATE_STATE = `(() => {
  const days = (${DAYS})();
  const caution = document.querySelector('[class*="pc-menu-blocks__caution"]');
  const box = caution?.parentElement?.firstElementChild;
  const heading = document.querySelector('[class*="type-selector"]');
  return {
    url: location.href,
    date: new URLSearchParams(location.search).get('date'),
    selectedMeal: (${BUTTON})()?.textContent.trim() ?? null,
    heading: heading?.firstChild?.nodeType === Node.TEXT_NODE ? heading.firstChild.textContent.trim() : null,
    days: days.map((button) => ({
      weekDay: button.children[0]?.textContent.trim() ?? null,
      dayOfMonth: Number(button.children[1]?.textContent.trim()),
      selected: /week__one-day--selected/.test(button.className),
    })),
    area: caution && box && box !== caution
      ? {
          caution: caution.textContent.trim(),
          boxChildren: box.children.length,
          blocks: [...box.querySelectorAll('[class*="header__place"]')].map((place) => ({
            place: place.textContent.trim(),
            menu: [...(place.parentElement?.parentElement?.querySelector('[class*="content__menu"]')?.children ?? [])]
              .map((item) => item.textContent.trim()),
          })),
        }
      : null,
  };
})()`;

/** KST 기준 달력일 키(YYYY-MM-DD). 페이지의 `kstDateKey`와 같은 규칙이다. */
function kstDateKey(instant) {
  return new Date(instant + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 선택된 요일 버튼(요일 순번과 일자)에 해당하는 달력일을, 자정 경계를 고려해 현재 시각 ±1일에서 찾는다. */
function selectedDateKey(state) {
  const selected = state.days.flatMap((entry, index) => (entry.selected ? [index] : []));
  if (state.days.length !== 7 || selected.length !== 1)
    fail(`Date control does not show one selected day in a 7-day week: ${JSON.stringify(state.days)}`);
  const [index] = selected;
  const key = [-DAY_MS, 0, DAY_MS]
    .map((offset) => kstDateKey(Date.now() + offset))
    .find((candidate) => {
      const date = new Date(`${candidate}T00:00:00Z`);
      return date.getUTCDay() === index && date.getUTCDate() === state.days[index].dayOfMonth;
    });
  if (!key) fail(`Selected day is not today in KST: ${JSON.stringify(state.days[index])}`);
  return { index, key };
}

/** 페이지의 `filterDinings`와 같은 규칙으로, API 응답에서 해당 끼니에 화면이 그려야 할 식단 블록을 구한다. */
function expectedBlocks(body, mealType) {
  const dinings = Array.isArray(body) ? body : [];
  return dinings
    .filter((dining) => dining.type === mealType && !dining.menu.some((name) => name.includes('미운영')))
    .map((dining) => ({ place: dining.display_place ?? dining.place, menu: dining.menu.map((name) => name.trim()) }));
}

const blockKeys = (blocks) => blocks.map((block) => JSON.stringify([block.place, block.menu])).sort();

/** 브라우저가 보낸 `GET …/dinings?date=YYMMDD` 요청과 그 완료 여부를 기록한다. */
async function watchDiningRequests(cdp) {
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.pathname.endsWith('/dinings'))
      requests.set(requestId, { date: url.searchParams.get('date'), url: url.href });
  });
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (requests.has(requestId)) requests.get(requestId).status = response.status;
  });
  cdp.on('Network.loadingFinished', ({ requestId }) => {
    if (requests.has(requestId)) requests.get(requestId).finished = true;
  });
  await cdp.send('Network.enable');
  return async (date) => {
    const found = [...requests].findLast(([, request]) => request.date === date && request.finished);
    if (!found) return null;
    const [requestId, request] = found;
    const { body, base64Encoded } = await cdp.send('Network.getResponseBody', { requestId });
    const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
    return { url: request.url, status: request.status, body: JSON.parse(text) };
  };
}

async function diningDateChange({ cdp, page, origin, outDir }) {
  const finishedDiningRequest = await watchDiningRequests(cdp);
  await openCafeteria(cdp, page, origin);
  const before = await waitFor('the date control and the dining area to be rendered', async () => {
    const current = await page.evaluate(DATE_STATE);
    return current.days.length === 7 && current.area ? current : null;
  });
  const from = selectedDateKey(before);
  if (before.date !== null && before.date !== from.key)
    fail(`URL query date=${before.date} does not match the selected day ${from.key}`);
  // 같은 주 안에서 바로 다음 날로 옮긴다. 토요일이면 다음 날 버튼이 없으므로 전날로 옮긴다.
  const toIndex = from.index < 6 ? from.index + 1 : from.index - 1;
  const toKey = kstDateKey(new Date(`${from.key}T00:00:00Z`).getTime() + (toIndex - from.index) * DAY_MS);
  const toHeading = toIndex > from.index ? '내일' : WEEK_DAYS[toIndex];
  if (before.heading !== '오늘') fail(`Dining area heading is not 오늘 before the change: ${before.heading}`);
  await page.screenshotFullPage(path.join(outDir, 'dining-date-change-before.png'));

  await page.click(`the ${WEEK_DAYS[toIndex]} day button`, day(toIndex));
  let mismatch = 'no state was read';
  const changed = await waitFor(`the page to switch from ${from.key} to ${toKey}`, async () => {
    const current = await page.evaluate(DATE_STATE);
    const selected = current.days.flatMap((entry, index) => (entry.selected ? [index] : []));
    const meal = MEALS.find(({ label }) => current.selectedMeal === `${label}식단`);
    const response = await finishedDiningRequest(toKey.slice(2).replaceAll('-', ''));
    const expected = response && meal ? expectedBlocks(response.body, meal.type) : null;
    const problems = [
      current.date !== toKey && `URL query date is ${current.date}`,
      (selected.length !== 1 || selected[0] !== toIndex) && `selected day index is ${JSON.stringify(selected)}`,
      current.heading !== toHeading && `dining area heading is ${current.heading}`,
      !meal && `meal selector shows ${current.selectedMeal}`,
      !response && `no finished GET /dinings request for ${toKey}`,
      !current.area && 'the dining area is not rendered',
      expected &&
        current.area &&
        JSON.stringify(blockKeys(current.area.blocks)) !== JSON.stringify(blockKeys(expected)) &&
        `rendered blocks ${JSON.stringify(current.area.blocks)} differ from the response ${JSON.stringify(expected)}`,
      expected?.length === 0 && current.area && current.area.boxChildren !== 0 && 'the empty dining box has children',
    ].filter(Boolean);
    mismatch = problems.join('; ');
    return problems.length === 0 ? { state: current, response, expected, meal } : null;
  }).catch((error) => fail(`${error.message} (${mismatch})`));
  const { state: after, response, expected, meal } = changed;
  await page.screenshotFullPage(path.join(outDir, 'dining-date-change-after.png'));

  const diningCase = expected.length > 0 ? 'menu' : 'empty';
  return {
    diningCase,
    assertions: [
      `date control initially selected ${from.key} (${WEEK_DAYS[from.index]}) and the dining area heading was 오늘`,
      `real mouse click on the ${WEEK_DAYS[toIndex]} day button`,
      `URL query became date=${toKey}`,
      `date control now selects only ${WEEK_DAYS[toIndex]} ${after.days[toIndex].dayOfMonth} and the dining area heading is ${toHeading}`,
      `the browser requested ${response.url} (HTTP ${response.status}) after the click`,
      diningCase === 'menu'
        ? `the dining area renders exactly the ${expected.length} ${meal.label} menu blocks of that response: ${expected.map((block) => block.place).join(', ')}`
        : `that response has no ${meal.label} menu, and the dining area shows its empty state: no menu blocks, only "${after.area.caution}"`,
    ],
    state: { before, after, from: from.key, to: toKey, diningResponse: { url: response.url, status: response.status } },
  };
}

// 화면 순회가 읽는 페이지 상태. NotFound 화면(routes/404.index.tsx)과 오류 경계(루트 errorComponent,
// components/boundary의 ErrorBoundary·StoreErrorBoundary)는 앱이 실제로 그리는 문구와 role로 찾는다.
const SCREEN_STATE = `(() => {
  const text = (node) => node.textContent.trim().replace(/\\s+/g, ' ').slice(0, 200);
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState === 'complete',
    hydrated: [document.body, ...document.body.querySelectorAll('*')].some((node) =>
      Object.keys(node).some((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')),
    ),
    notFound: [...document.querySelectorAll('[class*="content__title"]')].some(
      (node) => node.textContent.trim() === '개발 중인 페이지입니다',
    ),
    errorBoundaries: [
      ...[...document.querySelectorAll('h1')].filter(
        (node) => node.textContent.trim() === '페이지를 불러오지 못했습니다.',
      ),
      ...[...document.querySelectorAll('[role="alert"]')].filter(
        (node) => node.querySelector('h1') || /^Error( \\(참조 코드: .*\\))?$/.test(node.textContent.trim()),
      ),
    ].map(text),
  };
})()`;

/** 한 번의 방문 동안 문서 응답, 실패한 요청, 잡히지 않은 예외, console.error를 기록한다. */
async function watchPage(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const mainFrame = frameTree.frame.id;
  const requests = new Map();
  let record = null;
  cdp.on('Network.requestWillBeSent', ({ requestId, type, frameId }) => {
    if (!record) return;
    const document = type === 'Document' && frameId === mainFrame;
    if (document && !requests.has(requestId)) record.documentLoads += 1;
    requests.set(requestId, { document });
    record.pending.add(requestId);
    record.activityAt = Date.now();
  });
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const request = requests.get(requestId);
    if (!record || !request) return;
    if (request.document) record.documentStatus = response.status;
    if (response.status >= 400) record.failedRequests.push({ status: response.status, url: response.url });
  });
  const finished = ({ requestId }) => {
    if (!record) return;
    record.pending.delete(requestId);
    record.activityAt = Date.now();
  };
  cdp.on('Network.loadingFinished', finished);
  cdp.on('Network.loadingFailed', finished);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const message = exceptionDetails.exception?.description ?? exceptionDetails.text;
    record?.exceptions.push(String(message).slice(0, MAX_MESSAGE_LENGTH));
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error') return;
    const message = args.map((arg) => (arg.value === undefined ? (arg.description ?? arg.type) : String(arg.value)));
    record?.consoleErrors.push(message.join(' ').slice(0, MAX_MESSAGE_LENGTH));
  });
  await cdp.send('Network.enable');
  return {
    start() {
      requests.clear();
      record = {
        documentStatus: null,
        documentLoads: 0,
        failedRequests: [],
        consoleErrors: [],
        exceptions: [],
        pending: new Set(),
        activityAt: Date.now(),
      };
      return record;
    },
    stop() {
      record = null;
    },
  };
}

/** 화면을 새 방문자 상태로 열고, 하이드레이션과 네트워크가 잦아들 때까지 기다린 뒤의 상태와 기록을 돌려준다. */
async function visitScreen({ cdp, page, monitor, origin }, screen) {
  const idle = (record) => record.pending.size === 0 && Date.now() - record.activityAt >= IDLE_MS;
  let record;
  let state;
  let navigationError;
  for (let attempt = 0; attempt <= MAX_RELOADS; attempt += 1) {
    monitor.stop();
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await waitFor('a blank page', async () => (await page.evaluate('location.href')) === 'about:blank');
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    record = monitor.start();
    ({ errorText: navigationError } = await cdp.send('Page.navigate', { url: `${origin}${screen.path}` }));
    const hydrated = async () => {
      const current = await page.evaluate(SCREEN_STATE);
      return current.ready && current.hydrated ? current : null;
    };
    state = navigationError ? null : await waitFor(`${screen.id} to load and hydrate`, hydrated).catch(() => null);
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    while (!idle(record) && Date.now() < deadline) await sleep(100);
    // Vite 개발 서버는 새 의존성을 최적화하면 페이지를 통째로 다시 불러온다. 그 방문은 버리고 다시 잰다.
    if (record.documentLoads <= 1) break;
  }
  const networkIdle = idle(record);
  state = await page.evaluate(SCREEN_STATE).catch(() => state);
  monitor.stop();
  return { record, state, navigationError, networkIdle };
}

function summarize(label, messages) {
  return messages.length > 0 ? [`${messages.length} ${label}, first: ${messages[0]}`] : [];
}

/** 공개 화면의 실패 사유. 하나라도 있으면 그 뷰포트는 실패다. */
function publicFailures(screen, origin, { record, state, navigationError }) {
  const expectNotFound = screen.expect === 'not-found';
  return [
    navigationError && `navigation failed: ${navigationError}`,
    record.documentStatus === null && 'no document response was received',
    record.documentStatus >= 400 && `document response status ${record.documentStatus}`,
    !(state?.ready && state.hydrated) && `the page did not load and hydrate within ${STEP_TIMEOUT_MS}ms`,
    state?.notFound && !expectNotFound && 'the NotFound page was rendered',
    state && !state.notFound && expectNotFound && 'the NotFound page was not rendered',
    ...(state?.errorBoundaries ?? []).map((text) => `an error boundary was rendered: ${text}`),
    ...summarize('uncaught exception(s)', record.exceptions),
    ...summarize('console.error call(s)', record.consoleErrors),
    ...record.failedRequests
      .filter(({ status, url }) => status >= 500 && url.startsWith(`${origin}/api/`))
      .map(({ status, url }) => `same-origin API request answered ${status}: ${url}`),
  ].filter(Boolean);
}

/**
 * 로그인 화면은 로그인하지 않고, 비로그인 방문이 로그인 흐름에 닿는지만 본다.
 * 루트 beforeLoad가 보호 경로를 `/auth?redirect=<원래 주소>`로 돌려보낸다.
 */
function loginFailures(screen, origin, { record, state, navigationError }) {
  const url = state ? new URL(state.url) : null;
  const redirect = url?.searchParams.get('redirect');
  return [
    navigationError && `navigation failed: ${navigationError}`,
    record.documentStatus >= 400 && `document response status ${record.documentStatus}`,
    !(state?.ready && state.hydrated) && `the page did not load and hydrate within ${STEP_TIMEOUT_MS}ms`,
    url && url.pathname !== '/auth' && `an unauthenticated visit ended at ${url.pathname}${url.search}, not /auth`,
    url?.pathname === '/auth' &&
      !(redirect && new URL(redirect, origin).pathname === new URL(screen.path, origin).pathname) &&
      `the login redirect does not point back to ${screen.path}: ${redirect}`,
  ].filter(Boolean);
}

const screenshotNames = (screen) =>
  screen.access === 'public'
    ? [`${screen.id}-desktop.png`, `${screen.id}-mobile.png`]
    : screen.access === 'login'
      ? [`${screen.id}-desktop.png`]
      : [];

/** 개발 서버 하나로 화면들을 차례로 연다. 화면이 실패해도 멈추지 않고 화면별 결과를 모은다. */
async function screensSweep(context, screens) {
  const { cdp, page, origin, outDir } = context;
  const monitor = await watchPage(cdp);
  const userAgent = await page.evaluate('navigator.userAgent');
  const entries = screens.map(({ id, route, path: screenPath, access, reason }) => ({
    id,
    route,
    path: screenPath,
    access,
    status: access === 'disabled' ? 'skipped' : 'passed',
    ...(access === 'disabled' ? { reason } : {}),
    ...(access === 'login' ? { unverified: 'login required' } : {}),
  }));
  for (const [name, viewport] of Object.entries(SCREEN_VIEWPORTS)) {
    await cdp.send('Emulation.setDeviceMetricsOverride', viewport);
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: viewport.mobile ? MOBILE_USER_AGENT : userAgent });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
    for (const [index, screen] of screens.entries()) {
      if (!screenshotNames(screen).includes(`${screen.id}-${name}.png`)) continue;
      const visit = await visitScreen({ cdp, page, monitor, origin }, screen);
      const failures = (screen.access === 'login' ? loginFailures : publicFailures)(screen, origin, visit);
      const screenshot = `${screen.id}-${name}.png`;
      await page
        .screenshotFullPage(path.join(outDir, screenshot), MAX_CAPTURE_HEIGHT)
        .catch(() => page.screenshotViewport(path.join(outDir, screenshot)));
      entries[index][name] = {
        passed: failures.length === 0,
        failures,
        finalUrl: visit.state?.url ?? null,
        title: visit.state?.title ?? null,
        documentStatus: visit.record.documentStatus,
        documentLoads: visit.record.documentLoads,
        networkIdle: visit.networkIdle,
        failedRequests: visit.record.failedRequests,
        consoleErrors: visit.record.consoleErrors,
        exceptions: visit.record.exceptions,
        screenshot,
      };
      if (failures.length > 0) entries[index].status = 'failed';
      else if (screen.access === 'login') entries[index].status = 'unverified';
      console.error(`[web-scenario] ${screen.id} ${name}: ${failures.length === 0 ? 'ok' : failures.join('; ')}`);
    }
  }
  const count = (status) => entries.filter((entry) => entry.status === status).length;
  return {
    passed: count('failed') === 0,
    counts: {
      passed: count('passed'),
      failed: count('failed'),
      unverified: count('unverified'),
      skipped: count('skipped'),
    },
    screens: entries,
  };
}

const USAGE = `Usage: web-scenario.mjs --checkout DIR --scenario NAME --out DIR [--port N]
  NAME: ${Object.keys(SCENARIOS).join(' | ')}
        screen:<id>                           one screen of screens/web.json
        screens --ids a,b,c | --all-public | --all   several screens with a single dev server
        result:<id>                           exit 0 only when result.json in --out says the screen passed`;

/** --scenario와 선택 옵션에서 실행 계획(남길 파일, 실행 함수, 전체 제한 시간)을 정한다. */
async function plan(values) {
  const dining = {
    'dining-view': diningView,
    'dining-meal-change': diningMealChange,
    'dining-date-change': diningDateChange,
  }[values.scenario];
  if (dining) {
    return {
      files: SCENARIOS[values.scenario],
      meta: { route: '/cafeteria', viewport: VIEWPORT },
      timeoutMs: TOTAL_TIMEOUT_MS,
      run: dining,
    };
  }
  const single = /^screen:(.+)$/.exec(values.scenario ?? '')?.[1];
  if (!single && values.scenario !== 'screens') fail(USAGE);
  const inventory = validateInventory(JSON.parse(await readFile(INVENTORY, 'utf8')));
  const selectors = [values.ids, values['all-public'], values.all].filter(
    (value) => value !== undefined && value !== false,
  );
  if (single ? selectors.length > 0 : selectors.length !== 1) fail(USAGE);
  const ids = single ? [single] : (values.ids?.split(',') ?? null);
  const unknown = (ids ?? []).filter((id) => !inventory.some((screen) => screen.id === id));
  if (unknown.length > 0 || new Set(ids ?? []).size !== (ids ?? []).length)
    fail(`Unknown or repeated screen id: ${(unknown.length > 0 ? unknown : ids).join(', ')}`);
  const screens = inventory.filter((screen) =>
    ids ? ids.includes(screen.id) : values.all || screen.access === 'public',
  );
  return {
    files: screens.flatMap(screenshotNames),
    meta: { viewports: SCREEN_VIEWPORTS },
    timeoutMs: SWEEP_TIMEOUT_MS,
    run: (context) => screensSweep(context, screens),
  };
}

/** 순회가 남긴 result.json에서 한 화면의 결과만 읽는다. 서버도 브라우저도 띄우지 않는다. */
async function screenResult(outDir, id) {
  const result = JSON.parse(await readFile(path.join(outDir, 'result.json'), 'utf8'));
  const screen = result.screens?.find((entry) => entry.id === id);
  if (!screen) fail(`result.json has no screen ${id}`);
  console.log(JSON.stringify(screen, null, 2));
  if (screen.status !== 'passed') {
    const reasons = ['desktop', 'mobile'].flatMap((name) =>
      (screen[name]?.failures ?? []).map((failure) => `${name}: ${failure}`),
    );
    fail(`Screen ${id} is ${screen.status}${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}`);
  }
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
      ids: { type: 'string' },
      'all-public': { type: 'boolean' },
      all: { type: 'boolean' },
    },
  });
  if (!values.checkout || !values.out || !values.scenario) fail(USAGE);
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
  const resultOf = /^result:(.+)$/.exec(values.scenario)?.[1];
  if (resultOf) return screenResult(outDir, resultOf);
  const { files, meta, timeoutMs, run: runScenario } = await plan(values);
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
      return runScenario({ cdp, page: createPage(cdp), origin, outDir });
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Scenario exceeded the ${timeoutMs}ms total limit`)), timeoutMs);
    });
    const outcome = await Promise.race([run(), timeout]);
    const result = {
      scenario: values.scenario,
      passed: true,
      ...meta,
      startedAt,
      completedAt: new Date().toISOString(),
      screenshots: files,
      ...outcome,
    };
    await writeFile(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) {
      const failed = result.screens.filter(({ status }) => status === 'failed').map(({ id }) => id);
      fail(`${failed.length} of ${result.screens.length} screens failed: ${failed.join(', ')}`);
    }
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
