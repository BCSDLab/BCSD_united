import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Verify the actual Worker binding before any credential-bearing request. Keep the
// app's real gateway, transport, credential checks and session cookies unchanged.
export async function stageConfig(directory, webDir) {
  const file = path.join(directory, 'vite.config.mjs');
  const app = path.relative(directory, path.join(webDir, 'vite.config.ts')).replaceAll('\\', '/');
  const target = path.join(webDir, 'src/utils/ssr/apiTarget.ts').replaceAll('\\', '/');
  const module = `import * as actual from ${JSON.stringify(target)};
    import {env} from 'cloudflare:workers';
    export function getApiBaseUrl() {
      const base = actual.getApiBaseUrl();
      if (env.KOIN_API || base !== 'https://api.stage.koreatech.in') throw new Error('Stage API required');
      return base;
    }
    export async function fetchApiRequest(request) {
      const url = new URL(request.url);
      if (url.origin !== getApiBaseUrl()) throw new Error('Stage API required');
      const result = await actual.fetchApiRequest(request);
      if (url.pathname !== '/v2/web/auth/session') return result;
      const proof = new Response(result.body, result);
      proof.headers.set('X-Harness-Stage-Origin', url.origin);
      return proof;
    }`;
  await writeFile(
    file,
    `import original from ${JSON.stringify(app)};
    export default async env => {
      if (env.command !== 'serve' || env.isPreview) throw new Error('Stage verifier is dev-only');
      const config = await original(env);
      return {...config, plugins: [{
        name: 'stage-only-api-transport', enforce: 'pre',
        resolveId(id, importer, options) {
          if (options.ssr && id === 'utils/ssr/apiTarget') return '\\0stage-only-transport';
        },
        load(id) { if (id === '\\0stage-only-transport') return ${JSON.stringify(module)}; }
      }, ...config.plugins]};
    };`,
  );
  return file;
}

// Only the harness owns these inputs. Never send them to Vite/Chrome as environment variables.
const loginId = process.env.KOIN_STAGE_LOGIN_ID;
const password = process.env.MAESTRO_USER_PASSWORD;
export function screenChildEnv() {
  const { KOIN_STAGE_LOGIN_ID, MAESTRO_USER_PASSWORD, ...env } = process.env;
  return env;
}

const bySelector = (selector) => `() => document.querySelector(${JSON.stringify(selector)})`;
const button = (label) =>
  `() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length)`;

async function enterField({ cdp, page, origin }, selector, value) {
  await page.click('stage account field', bySelector(selector));
  if (
    !(await page.evaluate(
      `location.origin === ${JSON.stringify(origin)} && document.activeElement.matches(${JSON.stringify(selector)})`,
    ))
  )
    throw new Error('Unexpected origin or focused stage account field');
  await cdp.send('Input.insertText', { text: value });
}

async function proveAnonymousStage(context, waitFor) {
  const { cdp, page, origin } = context;
  if (origin !== 'http://localhost:3000' || process.env.AUTOFIX_OFFLINE_SMOKE === '1') return false;
  await cdp.send('Page.navigate', { url: `${origin}/auth?redirect=/setting` });
  await waitFor('local preview origin', () => page.evaluate(`location.origin === ${JSON.stringify(origin)}`));
  return page.evaluate(`location.origin === ${JSON.stringify(origin)} &&
    fetch('/api/v2/web/auth/session', {cache:'no-store', redirect:'error', signal:AbortSignal.timeout(10000)}).then(async r =>
      r.status === 200 && r.headers.get('X-Harness-Stage-Origin') === 'https://api.stage.koreatech.in' &&
      (await r.json()).authenticated === false)`);
}

async function signIn(context, waitFor) {
  const { page, origin } = context;
  await waitFor('hydrated stage login form', () =>
    page.evaluate(
      `location.origin === ${JSON.stringify(origin)} && Boolean(document.querySelector('input[name=userId]') && Object.keys(document.querySelector('input[name=userId]')).some(k => k.startsWith('__reactProps$')))`,
    ),
  );
  await enterField(context, 'input[name=userId]', loginId);
  await enterField(context, 'input[type=password][name=password]', password);
  await page.click('submit stage login', bySelector('form button[type=submit]'));
  await waitFor('stage login to complete', () =>
    page.evaluate(
      `location.origin === ${JSON.stringify(origin)} && ['/setting','/setting/'].includes(location.pathname)`,
    ),
  );
  if (!(await authenticated(page))) throw new Error('Stage session was not authenticated after login');
}

export function authenticated(page) {
  return page.evaluate(
    `location.origin === 'http://localhost:3000' && fetch('/api/v2/web/auth/session', {cache:'no-store', redirect:'error', signal:AbortSignal.timeout(10000)}).then(async r =>
      r.status === 200 && r.headers.get('X-Harness-Stage-Origin') === 'https://api.stage.koreatech.in' && (await r.json()).authenticated === true)`,
  );
}

// Reauthentication is an application navigation: the password confirmation is deliberately
// not persisted across hard reloads. Never replace it by writing Zustand or browser storage.
export async function openProfile(context, waitFor) {
  const { cdp, page, origin } = context;
  await cdp.send('Page.navigate', { url: `${origin}/setting` });
  await page.click('authenticated profile settings', button('프로필'));
  await enterField(context, 'input[type=password][placeholder="비밀번호를 입력해주세요"]', password);
  await page.click('confirm stage account password', button('확인하기'));
  await waitFor('password-confirmed profile', () =>
    page.evaluate(`location.pathname === '/auth/modifyinfo' || location.pathname === '/auth/modifyinfo/'`),
  );
}

// Runs in the signed-in browser once. Return only route bindings (ephemeral positive IDs).
// Never serialize a response, participant, review or resolved URL into an artifact.
async function fixtureBindings(templates, postId, shopId) {
  if (location.origin !== 'http://localhost:3000') throw new Error('Unexpected preview origin');
  const needed = (key) => templates.some((template) => template.includes(`:${key}`));
  const id = (v) => Number.isSafeInteger(v) && v > 0;
  const get = async (path) => {
    try {
      const response = await fetch(`/api${path}`, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const bindings = {};
  if (needed('postId')) {
    if (postId === null) {
      const { posts } = (await get('/callvan?joined=true&page=1&limit=50')) ?? {};
      const joined = Array.isArray(posts) ? posts.filter((p) => p?.is_joined === true && id(p.id)) : [];
      postId = (needed('userId') ? (joined.find((p) => p.current_participants > 1) ?? joined[0]) : joined[0])?.id;
    }
    const detail = id(postId) ? await get(`/callvan/posts/${postId}`) : null;
    if (
      detail?.id === postId &&
      Array.isArray(detail?.participants) &&
      detail.participants.some((p) => p?.is_me === true)
    ) {
      bindings.postId = postId;
      const other = detail.participants.find((p) => p?.is_me === false && id(p.user_id));
      if (other && needed('userId')) bindings.userId = other.user_id;
    }
  }
  if (needed('shopId') && id(shopId) && (await get(`/shops/${shopId}`))?.id === shopId) {
    bindings.shopId = shopId;
    for (const [key, own] of [
      ['ownReviewId', true],
      ['otherReviewId', false],
    ]) {
      if (!needed(key)) continue;
      const { reviews } = (await get(`/shops/${shopId}/reviews${own ? '/me' : ''}?sorter=LATEST`)) ?? {};
      const review =
        Array.isArray(reviews) &&
        reviews.find((r) => r?.is_mine === own && (own || r.is_reported === false) && id(r.review_id));
      if (review) bindings[key] = review.review_id;
    }
  }
  return bindings;
}

const dependencies = {
  postId: 'joined-callvan-post',
  userId: 'second-callvan-participant',
  shopId: 'fixture-shop',
  ownReviewId: 'account-owned-review',
  otherReviewId: 'reportable-other-review',
};

// Kept separate from the route cache so callers cannot accidentally write IDs into evidence.
export async function stagePreflight(context, screens, waitFor) {
  const protectedScreens = screens.filter((s) => s.access === 'authenticated');
  const stageOrigin = await proveAnonymousStage(context, waitFor).catch(() => false);
  const findings = {
    stageOrigin: stageOrigin ? 'verified' : 'unverified',
    login: 'not-requested',
    fixtures: {},
  };
  let blocked = null;
  if (protectedScreens.length) {
    if (!stageOrigin) blocked = 'stage-origin-unverified';
    else if (!loginId || !password) blocked = 'missing-stage-credentials';
    else {
      try {
        await signIn(context, waitFor);
      } catch {
        blocked = 'stage-login-unavailable';
      }
    }
    findings.login = blocked ?? 'verified';
  }
  const templates = protectedScreens.map((s) => s.path);
  let bindings = {};
  if (!blocked && templates.some((p) => p.includes(':'))) {
    const input = process.env.KOIN_STAGE_CALLVAN_POST_ID;
    const args = [
      templates,
      input ? (Number.isSafeInteger(Number(input)) ? Number(input) : -1) : null,
      Number(process.env.KOIN_STAGE_SHOP_ID || 11),
    ];
    bindings =
      (await context.page.evaluate(`(${fixtureBindings})(...${JSON.stringify(args)})`).catch(() => null)) ?? {};
  }
  const routes = new Map();
  for (const { id, path } of protectedScreens) {
    let unavailable = blocked;
    const route = path.replace(/:(\w+)/g, (_, key) => {
      const available = Number.isSafeInteger(bindings[key]) && bindings[key] > 0;
      findings.fixtures[dependencies[key]] = blocked ? 'not-checked' : available ? 'verified' : 'unavailable';
      if (!available) unavailable ??= dependencies[key];
      return available ? String(bindings[key]) : '';
    });
    routes.set(id, unavailable ? { blocked: unavailable } : { path: route });
  }
  return { findings, routes };
}

// Record only the public label (or the empty chat composer), never a whole signed-in
// viewport containing profile details, review content, or chat messages.
function visibleClip(selector, label) {
  const nodes = selector ? document.querySelectorAll(selector) : document.querySelectorAll('body *');
  for (const element of nodes) {
    const text = [...element.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === label);
    if (selector ? !(element instanceof HTMLTextAreaElement && element.value === '') : !text) continue;
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    const { x, y, width, height } = text ? range.getBoundingClientRect() : element.getBoundingClientRect();
    if (!(width > 0 && height > 0) || !element.contains(document.elementFromPoint(x + width / 2, y + height / 2)))
      continue;
    return { x: scrollX + x, y: scrollY + y, width, height, scale: 1 };
  }
  return null;
}

export function targetClip(page, { target, targetText }) {
  return page.evaluate(`(${visibleClip})(...${JSON.stringify([target, targetText])})`);
}
