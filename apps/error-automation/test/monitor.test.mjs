import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const platform =
  'data:text/javascript,' +
  encodeURIComponent('export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: platform, shortCircuit: true };
    if (
      specifier.startsWith('./') &&
      context.parentURL?.includes('/apps/error-automation/src/') &&
      !specifier.endsWith('.ts')
    )
      return nextResolve(specifier + '.ts', context);
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import('../src/index.ts');
const { parseRockyMonitorSnapshot } = await import('@koin/telemetry/monitor');
const monitorToken = 'read-only-monitor-' + 'm'.repeat(40);
const executorToken = 'executor-only-' + 'e'.repeat(40);
function harness(read) {
  let reads = 0;
  let forbidden = 0;
  const never = () => {
    forbidden++;
    throw new Error('Privileged operation must not run');
  };
  const env = {
    ENVIRONMENT: 'production',
    ERROR_MONITOR_TOKEN: monitorToken,
    AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc',
    AUTOFIX_EXECUTOR_TOKEN: executorToken,
    OMP_GATEWAY: { fetch: never },
    ERROR_ISSUES: { get: never, idFromName: never },
    AUTOFIX_QUEUE: {
      getByName() {
        return {
          async monitorSnapshot(now) {
            reads++;
            if (read) return read(now);
            return {
              version: 1,
              scope: 'ingress-only',
              worker: 'responding',
              checkedAt: now,
              windowStart: now - 86400000,
              sources: { sentry: { count: 0, latestAt: null }, cloudflare: { count: 0, latestAt: null } },
              recent: [],
            };
          },
          claim: never,
          enqueue: never,
          errorStatus: never,
        };
      },
    },
  };
  function request(path = '/healthz', token = monitorToken, method = 'GET') {
    return worker.fetch(
      new Request('https://automation.example' + path, {
        method,
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          'X-Executor-Id': 'koin-rocky-umpc',
          'Content-Type': 'application/json',
        },
      }),
      env,
    );
  }
  return { env, request, reads: () => reads, forbidden: () => forbidden };
}

test('monitor authentication is separate from executor access and runs without model configuration', async () => {
  const h = harness();
  assert.equal((await h.request('/healthz', null)).status, 401);
  assert.equal((await h.request('/healthz', executorToken)).status, 401);
  assert.equal(h.reads(), 0);
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.scope, 'ingress-only');
  assert.ok(!('executor' in body) && !('cpu' in body) && !('ram' in body));
  assert.equal((await h.request('/executor/claim', monitorToken, 'POST')).status, 401);
  assert.equal(h.forbidden(), 0);
});

test('monitor credentials and exact GET path are required before reading storage', async () => {
  const h = harness();
  assert.equal((await h.request('/healthz', monitorToken, 'POST')).status, 405);
  assert.equal((await h.request('/healthz?url=https://untrusted.example')).status, 400);
  assert.equal(h.reads(), 0);
  h.env.ERROR_MONITOR_TOKEN = undefined;
  assert.equal((await h.request()).status, 503);
  assert.equal(h.reads(), 0);
});

test('unavailable or unexpectedly detailed monitoring data cannot be reported as healthy', async () => {
  const secret = 'private-provider-detail';
  const h = harness(() => {
    throw new Error(secret);
  });
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(secret));
  const stale = harness((now) => ({
    version: 1,
    scope: 'ingress-only',
    worker: 'responding',
    checkedAt: now - 121000,
    windowStart: now - 121000 - 86400000,
    sources: { sentry: { count: 0, latestAt: null }, cloudflare: { count: 0, latestAt: null } },
    recent: [],
  }));
  assert.equal((await stale.request()).status, 503);
  assert.equal(h.forbidden(), 0);
});

test('monitoring storage has a bounded deadline without invoking privileged work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const h = harness(() => {
    started.resolve();
    return stopped.promise;
  });
  const pending = h.request();
  await started.promise;
  t.mock.timers.tick(3000);
  assert.equal((await pending).status, 503);
  assert.equal(h.forbidden(), 0);
});

const rockyToken = 'rocky-monitor-' + 'r'.repeat(40);
function rockySnapshot(now = Date.now()) {
  const unit = { configured: true, state: 'active', process: 'running', checkedAt: now };
  return {
    version: 1,
    scope: 'rocky-read-only',
    checkedAt: now,
    gateway: 'responding',
    cpu: { usagePercent: 0, sampleStart: now - 200, sampleEnd: now },
    memory: { totalBytes: 8192, availableBytes: 6144, usedBytes: 2048, checkedAt: now },
    executor: { ...unit },
    broker: { ...unit },
    brokerResponse: 'not_probed',
    model: 'not_probed',
  };
}

test('Rocky monitoring rejects unauthorized and parameterized requests before private host access', async () => {
  const h = harness();
  h.env.OMP_GATEWAY_MONITOR_TOKEN = rockyToken;
  for (const token of [null, executorToken, rockyToken])
    assert.equal((await h.request('/healthz/rocky', token)).status, 401);
  assert.equal((await h.request('/healthz/rocky', monitorToken, 'POST')).status, 405);
  assert.equal((await h.request('/healthz/rocky?url=https://attacker.example')).status, 400);
  assert.equal(h.forbidden(), 0);
  assert.equal(h.reads(), 0);
});

test('Rocky health is reachable only through the pinned VPC path with a role-separated credential', async () => {
  const h = harness();
  h.env.OMP_GATEWAY_TOKEN = 'model-' + 'p'.repeat(40);
  h.env.OMP_GATEWAY_MONITOR_TOKEN = rockyToken;
  let requests = 0;
  h.env.OMP_GATEWAY.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'http://omp-gateway/healthz');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer ' + rockyToken);
    assert.notEqual(options.headers.Authorization, 'Bearer ' + h.env.OMP_GATEWAY_TOKEN);
    return Response.json(rockySnapshot());
  };
  const response = await h.request('/healthz/rocky');
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.gateway, 'responding');
  assert.equal(snapshot.brokerResponse, 'not_probed');
  assert.equal(snapshot.model, 'not_probed');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(requests, 1);
  assert.equal(h.reads(), 0);
  assert.equal(h.forbidden(), 0);
  for (const token of [undefined, monitorToken, executorToken, h.env.OMP_GATEWAY_TOKEN]) {
    h.env.OMP_GATEWAY_MONITOR_TOKEN = token;
    assert.equal((await h.request('/healthz/rocky')).status, 503);
  }
  assert.equal(requests, 1);
  assert.equal((await h.request()).status, 200);
});

test('Rocky failures, redirects, stale samples and sensitive extra fields never become healthy host data', async () => {
  const h = harness();
  h.env.OMP_GATEWAY_MONITOR_TOKEN = rockyToken;
  for (const response of [
    () => Response.redirect('https://attacker.example', 302),
    () => new Response('private-broker-error', { status: 500 }),
    () => Response.json(rockySnapshot(Date.now() - 121_000)),
    () => Response.json({ ...rockySnapshot(), credentials: 'private-broker-token' }),
    () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '16385' } }),
  ]) {
    h.env.OMP_GATEWAY.fetch = async () => response();
    const reply = await h.request('/healthz/rocky');
    assert.equal(reply.status, 503);
    assert.doesNotMatch(await reply.text(), /private-broker/);
    assert.equal((await h.request()).status, 200);
  }
  assert.equal(h.forbidden(), 0);
});

test('Rocky health deadline bounds a stalled response body and aborts the private request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers();
  const h = harness();
  h.env.OMP_GATEWAY_MONITOR_TOKEN = rockyToken;
  let aborted = false;
  h.env.OMP_GATEWAY.fetch = async (_url, options) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
    });
    started.resolve();
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
  };
  const pending = h.request('/healthz/rocky');
  await started.promise;
  t.mock.timers.tick(3000);
  assert.equal((await pending).status, 503);
  assert.equal(aborted, true);
  assert.equal(h.forbidden(), 0);
});

test('Rocky parser distinguishes measured idle, missing measurements and unprobed broker/model health', () => {
  const now = Date.now();
  const snapshot = rockySnapshot(now);
  assert.deepEqual(parseRockyMonitorSnapshot(snapshot, now), snapshot);
  const unknownUnit = { configured: null, state: 'unknown', process: 'unknown', checkedAt: null };
  const unknown = { ...snapshot, cpu: null, memory: null, executor: unknownUnit, broker: unknownUnit };
  assert.deepEqual(parseRockyMonitorSnapshot(unknown, now), unknown);
  for (const invalid of [
    { ...snapshot, brokerResponse: 'responding' },
    { ...snapshot, model: 'healthy' },
    { ...snapshot, cpu: { ...snapshot.cpu, sampleEnd: now - 200 } },
    { ...snapshot, cpu: { ...snapshot.cpu, usagePercent: 101 } },
    { ...snapshot, memory: { ...snapshot.memory, usedBytes: 0 } },
    { ...snapshot, memory: { ...snapshot.memory, availableBytes: 8193 } },
    { ...snapshot, executor: { ...snapshot.executor, configured: false } },
    { ...snapshot, broker: { ...snapshot.broker, checkedAt: now - 121_000 } },
    { ...snapshot, broker: { ...snapshot.broker, checkedAt: now + 1 } },
    { ...snapshot, broker: { ...snapshot.broker, raw: 'private state' } },
  ])
    assert.equal(parseRockyMonitorSnapshot(invalid, now), null);
});
