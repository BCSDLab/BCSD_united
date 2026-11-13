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
