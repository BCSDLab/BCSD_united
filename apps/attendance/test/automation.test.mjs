import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import worker from '../src/index.ts';
import { getAutomationResult, handleAutomation } from '../src/automation.ts';

// Workers expose crypto.subtle.timingSafeEqual; Node's Web Crypto does not.
if (!globalThis.crypto.subtle.timingSafeEqual) {
  Object.defineProperty(globalThis.crypto.subtle, 'timingSafeEqual', {
    value: (left, right) => timingSafeEqual(Buffer.from(left), Buffer.from(right)),
    configurable: true,
  });
}

const NOW = Date.UTC(2026, 10, 13, 12);
const TOKEN = 'm'.repeat(32);
const AUTH = 'Basic ' + btoa('dashboard:secret');
const JOB_ID = 'autofix-' + 'a'.repeat(64);
const snapshot = (overrides = {}) => ({
  version: 1,
  scope: 'ingress-only',
  checkedAt: NOW,
  windowStart: NOW - 24 * 60 * 60 * 1000,
  worker: 'responding',
  sources: {
    sentry: { count: 1, latestAt: NOW - 1000 },
    cloudflare: { count: 0, latestAt: null },
  },
  recent: [{ id: JOB_ID, source: 'sentry', app: 'web', registeredAt: NOW - 1000, status: 'queued' }],
  ...overrides,
});
const json = (value) => Response.json(value);
const binding = (fetch) => ({ fetch });
const env = (fetch) => ({
  ERROR_AUTOMATION: binding(fetch),
  ERROR_MONITOR_TOKEN: TOKEN,
  DASHBOARD_PASSWORD: 'secret',
  DEVICE_TOKEN: 'device-secret',
  ATTENDANCE: new Proxy(
    {},
    {
      get: () => {
        throw new Error('monitor must never touch attendance KV');
      },
    },
  ),
});
const request = (headers = {}, path = '/api/automation') =>
  new Request('https://attendance.example' + path, { headers });

// The route, not a test-only wrapper, must enforce dashboard Basic before any binding call.
test('automation route rejects unauthenticated and RFID Bearer callers before upstream access', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let calls = 0;
  const workerEnv = env(async (url) => {
    calls++;
    assert.equal(url, 'https://error-automation.internal/healthz');
    return json(snapshot());
  });
  for (const headers of [{}, { authorization: 'Bearer device-secret' }, { authorization: 'Basic !!!' }]) {
    const response = await worker.fetch(request(headers), workerEnv);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal(calls, 0);
  const response = await worker.fetch(
    request({ authorization: AUTH }, '/api/automation?url=https%3A%2F%2Fattacker.example%2Fhealthz'),
    workerEnv,
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).state, 'ok');
});

test('fixed service binding, HTTPS path, private token, and no redirect follow', async () => {
  let calls = 0;
  const result = await getAutomationResult(
    env(async (url, options) => {
      calls++;
      assert.equal(url, 'https://error-automation.internal/healthz');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, 'Bearer ' + TOKEN);
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal);
      return Response.redirect('https://attacker.example/collect', 302);
    }),
    () => NOW,
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { state: 'unknown', checkedAt: null, data: null, reason: 'unavailable' });
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('missing or short server-side secret and missing binding never fabricate empty traffic', async () => {
  let calls = 0;
  const base = env(async () => {
    calls++;
    return json(snapshot());
  });
  for (const settings of [
    { ERROR_AUTOMATION: undefined },
    { ERROR_MONITOR_TOKEN: undefined },
    { ERROR_MONITOR_TOKEN: 'device-secret' },
  ]) {
    const result = await getAutomationResult({ ...base, ...settings }, () => NOW);
    assert.deepEqual(result, { state: 'unknown', checkedAt: null, data: null, reason: 'not_configured' });
  }
  assert.equal(calls, 0);
});

test('quiet observed zero is healthy; stale, malformed, and sensitive extra fields are unknown', async () => {
  const empty = snapshot({
    sources: { sentry: { count: 0, latestAt: null }, cloudflare: { count: 0, latestAt: null } },
    recent: [],
  });
  const good = await getAutomationResult(
    env(async () => json(empty)),
    () => NOW,
  );
  assert.equal(good.state, 'ok');
  assert.equal(good.data.sources.sentry.count, 0);
  for (const payload of [
    snapshot({
      checkedAt: NOW - 121_000,
      windowStart: NOW - 121_000 - 24 * 60 * 60 * 1000,
      sources: empty.sources,
      recent: [],
    }),
    snapshot({ sources: { sentry: { count: -1, latestAt: NOW }, cloudflare: { count: 0, latestAt: null } } }),
    snapshot({ recent: [{ ...snapshot().recent[0], diagnostic: 'private stack trace' }] }),
    snapshot({ pr_url: 'https://github.example/private' }),
  ]) {
    const result = await getAutomationResult(
      env(async () => json(payload)),
      () => NOW,
    );
    assert.equal(result.state, 'unknown');
    assert.equal(result.data, null);
    assert.equal(result.checkedAt, null);
    assert.ok(!JSON.stringify(result).includes('private stack trace'));
  }
});

test('stale but structurally valid snapshot has explicit unknown/stale state, not zero', async () => {
  const checkedAt = NOW - 121_000;
  const payload = snapshot({
    checkedAt,
    windowStart: checkedAt - 24 * 60 * 60 * 1000,
    sources: { sentry: { count: 0, latestAt: null }, cloudflare: { count: 0, latestAt: null } },
    recent: [],
  });
  assert.deepEqual(
    await getAutomationResult(
      env(async () => json(payload)),
      () => NOW,
    ),
    {
      state: 'unknown',
      checkedAt: null,
      data: null,
      reason: 'stale',
    },
  );
});

test('body size bounds apply even to streaming responses without Content-Length', async () => {
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10_000));
      controller.enqueue(new Uint8Array(7_000));
      controller.close();
    },
  });
  for (const response of [
    () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '16385' } }),
    () => new Response(oversized, { headers: { 'content-type': 'application/json' } }),
    () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }),
    () => new Response(JSON.stringify(snapshot()), { headers: { 'content-type': 'text/html' } }),
  ]) {
    const result = await getAutomationResult(
      env(async () => response()),
      () => NOW,
    );
    assert.deepEqual(result, { state: 'unknown', checkedAt: null, data: null, reason: 'unavailable' });
  }
});

test('five-second deadline covers a stalled response body, not merely binding fetch', { timeout: 8_000 }, async () => {
  let aborted = false;
  const start = performance.now();
  const result = await getAutomationResult(
    env(async (_url, options) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.of(123));
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }),
    () => NOW,
  );
  assert.deepEqual(result, { state: 'unknown', checkedAt: null, data: null, reason: 'unavailable' });
  assert.ok(aborted);
  assert.ok(performance.now() - start >= 4_900);
});

test('API response does not expose monitor token, upstream diagnostic fields, or cacheable data', async () => {
  const response = await handleAutomation(env(async () => json(snapshot())));
  const body = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!body.includes(TOKEN));
  assert.ok(!body.includes('diagnostic'));
  assert.ok(!body.includes('sourceId'));
  assert.ok(!body.includes('pr_url'));
});
