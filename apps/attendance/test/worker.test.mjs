import assert from 'node:assert/strict';
import test, { before, after, mock } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../src/viewer.ts';
import { buildViewer } from '../scripts/build-viewer.mjs';

const AUD = 'isolated-viewer-test-audience';
const ctx = { access: { aud: AUD } };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTyoAAAAASUVORK5CYII=';
const jsonPaths = ['/api/state', '/api/monitor', '/api/koin-health', '/api/worker-health', '/api/spotify', '/api/jam'];
const paths = [
  '/',
  '/health',
  '/api/events',
  '/api/view-status',
  ...jsonPaths,
  '/api/wifi-qr/2.4',
  '/api/wifi-qr/5',
  '/api/jam-qr',
];
let worker, directory, html;
before(async () => {
  mock.method(globalThis, 'fetch', () => {
    assert.fail('Unexpected real network fetch');
  });
  directory = await mkdtemp(join(tmpdir(), 'attendance-viewer-'));
  html = await readFile(await buildViewer(join(directory, 'dashboard.html')), 'utf8');
  worker = createViewer(html);
});
after(async () => {
  mock.restoreAll();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function snapshot(now = Date.now()) {
  return {
    version: 1,
    observedAt: now - 1000,
    publishedAt: now - 500,
    payloads: Object.fromEntries(
      jsonPaths.map((path) => [
        path,
        {
          status: 200,
          body: { path, now: now - 2000, collectedAt: now - 3000, actual: true },
        },
      ]),
    ),
    assets: { '/api/wifi-qr/2.4': PNG, '/api/wifi-qr/5': PNG, '/api/jam-qr': PNG },
  };
}
function environment(value = snapshot()) {
  const store = {
    raw: value === null ? null : JSON.stringify(value),
    reads: 0,
    async get(key, type) {
      assert.equal(key, 'clubroom:view:v1');
      assert.equal(type, 'arrayBuffer');
      this.reads++;
      return this.raw === null || this.raw instanceof ArrayBuffer
        ? this.raw
        : new TextEncoder().encode(this.raw).buffer;
    },
  };
  return { store, CF_ACCESS_AUD: AUD, VIEW_STATE: store };
}
function get(env, path = '/api/state', context = ctx, options = {}) {
  return worker.fetch(new Request(`https://attendance.example${path}`, options), env, context);
}
function assertPrivate(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-bcsd-view-mode'), 'eventually-consistent-snapshot');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin'])
    assert.equal(response.headers.get(name), null);
}

test('missing/wrong platform audience and spoofed headers never cause any KV access', async () => {
  const env = environment();
  for (const context of [
    undefined,
    {},
    { access: {} },
    { access: { aud: 'other-worker' } },
    { access: { aud: [AUD] } },
  ]) {
    for (const path of paths) {
      const response = await worker.fetch(
        new Request(`https://attendance.example${path}`, {
          headers: {
            'cf-access-jwt-assertion': 'unverified.jwt.assertion',
            'cf-access-authenticated-user-email': 'admin@example.test',
            'cf-warp-tag-id': AUD,
            authorization: 'Bearer client-token',
            cookie: 'CF_Authorization=client-token',
          },
        }),
        env,
        context,
      );
      assert.equal(response.status, 403);
      assertPrivate(response);
    }
  }
  assert.equal(env.store.reads, 0);
  assert.equal((await get(env)).status, 200);
  assert.equal(env.store.reads, 1);
});

test('missing dedicated namespace/audience fails closed and legacy attendance KV is never used', async () => {
  for (const change of [
    { VIEW_STATE: undefined },
    { CF_ACCESS_AUD: undefined },
    { CF_ACCESS_AUD: '' },
    { CF_ACCESS_AUD: ` ${AUD}` },
    { CF_ACCESS_AUD: 'x'.repeat(257) },
  ]) {
    const env = Object.assign(environment(), change);
    assert.equal((await get(env)).status, 503);
    assert.equal(env.store.reads, 0);
  }
  const legacy = { ATTENDANCE: environment().store, CF_ACCESS_AUD: AUD };
  assert.equal((await get(legacy)).status, 503);
  assert.equal(legacy.ATTENDANCE.reads, 0);
});

test('build serves the current complete LAN dashboard with truthful hosted notice and no KV HTML', async () => {
  const env = environment(null);
  const response = await get(env, '/');
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), html);
  for (const marker of [
    '<!doctype html>',
    'monitor-view',
    'spotify-now',
    'cloud-snapshot',
    '원격 스냅샷',
    '/api/view-status',
  ]) {
    assert.ok(html.includes(marker), marker);
  }
  assert.ok(!html.includes('변경 즉시 갱신'));
  assert.ok(!html.includes('임시 LAN 운영 · 로그인 없음'));
  assert.ok(!html.includes('new EventSource('));
  const head = await get(env, '/', ctx, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(env.store.reads, 0);
});

test('every JSON route preserves actual data, original clocks and error statuses', async () => {
  const value = snapshot();
  value.payloads['/api/koin-health'].status = 503;
  value.payloads['/api/spotify'].status = 401;
  const env = environment(value);
  for (const path of jsonPaths) {
    const response = await get(env, path);
    assert.equal(response.status, value.payloads[path].status);
    assert.deepEqual(await response.json(), value.payloads[path].body);
    assertPrivate(response);
    assert.equal(response.headers.get('x-bcsd-snapshot-observed-at'), String(value.observedAt));
    assert.equal(response.headers.get('x-bcsd-snapshot-published-at'), String(value.publishedAt));
  }
  const health = await (await get(env, '/health')).json();
  assert.equal(health.mode, 'hosted_snapshot');
  assert.equal(health.consistency, 'eventual');
  assert.equal(health.observedAt, value.observedAt);
});

test('view status exposes only actual snapshot availability/timestamps and fails closed on stale/missing data', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const value = snapshot(now);
  const env = environment(value);
  const fresh = await get(env, '/api/view-status');
  assert.equal(fresh.status, 200);
  assertPrivate(fresh);
  assert.deepEqual(await fresh.json(), {
    available: true,
    observedAt: value.observedAt,
    publishedAt: value.publishedAt,
    ageMs: 1000,
  });
  t.mock.timers.tick(300_001);
  const stale = await get(env, '/api/view-status');
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), {
    available: false,
    observedAt: value.observedAt,
    publishedAt: value.publishedAt,
    ageMs: 301001,
  });
  assert.equal(stale.headers.get('x-bcsd-snapshot-observed-at'), String(value.observedAt));
  env.store.raw = null;
  const missing = await get(env, '/api/view-status');
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { available: false, observedAt: null, publishedAt: null, ageMs: null });
  assert.equal(missing.headers.get('x-bcsd-snapshot-observed-at'), null);
  env.VIEW_STATE = undefined;
  assert.equal((await get(env, '/')).status, 200);
  assert.equal((await get(env, '/api/view-status')).status, 503);
});

test('camera/auth/admin/writes/arbitrary paths/queries and non-root HEAD never read KV', async () => {
  const env = environment();
  for (const path of [
    '/api/login',
    '/api/logout',
    '/api/taps',
    '/api/me',
    '/api/members',
    '/api/admin',
    '/api/camera',
    '/api/camera-stream',
    '/api/camera/snapshot',
    '/api/camera.jpg',
    '/api/wifi-qr/config',
    '/api/state/',
    '/api/%73tate',
    '//attacker.example/api/state',
    '/http://attacker.example',
    '/constructor',
    '/__proto__',
  ]) {
    assert.equal((await get(env, path)).status, 404, path);
  }
  for (const path of paths) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
      assert.equal((await get(env, path, ctx, { method })).status, 405);
    if (path !== '/') assert.equal((await get(env, path, ctx, { method: 'HEAD' })).status, 405);
    assert.equal((await get(env, `${path}?url=http://attacker.example`)).status, 400);
    assert.equal((await get(env, `${path}?`)).status, 400);
  }
  assert.equal(env.store.reads, 0);
});

test('client auth/cookies/forwarding/conditional headers cannot select data or become response headers', async () => {
  const value = snapshot();
  const env = environment(value);
  const response = await get(env, '/api/state', ctx, {
    headers: {
      authorization: 'Bearer private',
      cookie: 'private-cookie',
      'cf-access-jwt-assertion': 'private-assertion',
      origin: 'https://attacker.example',
      host: 'attacker.example',
      forwarded: 'host=attacker.example',
      'x-forwarded-for': '1.2.3.4',
      range: 'bytes=0-5',
      'if-none-match': 'private-etag',
    },
  });
  assert.deepEqual(await response.json(), value.payloads['/api/state'].body);
  assertPrivate(response);
  assert.ok(!JSON.stringify([...response.headers]).includes('private-cookie'));
  assert.equal(env.store.reads, 1);
});

test('missing, invalid UTF-8, malformed, null, oversized and unavailable snapshots fail closed', async () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}', new Uint8Array([0xff]).buffer, new ArrayBuffer(2_097_153)]) {
    const env = environment();
    env.store.raw = raw;
    const response = await get(env);
    assert.equal(response.status, 503);
    assertPrivate(response);
  }
  const env = environment();
  env.store.get = async () => {
    throw new Error('private namespace detail');
  };
  const response = await get(env);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private namespace'));
});

test('snapshot schema, timestamps and JSON status validation reject partial or unexpected data', async () => {
  const changes = [
    (s) => {
      s.version = 2;
    },
    (s) => {
      delete s.payloads['/api/monitor'];
    },
    (s) => {
      s.payloads['/api/camera'] = { status: 200, body: {} };
    },
    (s) => {
      s.observedAt = '1';
    },
    (s) => {
      s.publishedAt = s.observedAt - 1;
    },
    (s) => {
      s.publishedAt = Date.now() + 60_000;
    },
    (s) => {
      s.observedAt = 0;
    },
    (s) => {
      s.admin = { secret: 'private' };
    },
    (s) => {
      s.payloads['/api/state'].headers = { 'set-cookie': 'secret' };
    },
    (s) => {
      s.payloads['/api/state'].body = null;
    },
    (s) => {
      delete s.assets['/api/wifi-qr/5'];
    },
  ];
  for (const status of [101, 199, 204, 205, 301, 302, 304, 307, 600, 200.5, '200']) {
    changes.push((s) => {
      s.payloads['/api/state'].status = status;
    });
  }
  for (const change of changes) {
    const value = snapshot();
    change(value);
    const response = await get(environment(value));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'snapshot_malformed');
  }
});

test('observation age alone enforces cutoff: exactly five minutes accepted, older data rejected', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const value = snapshot(now);
  value.observedAt = now - 300_000;
  value.publishedAt = now;
  const env = environment(value);
  assert.equal((await get(env)).status, 200);
  t.mock.timers.tick(1);
  for (const path of [...jsonPaths, '/health', '/api/events', '/api/wifi-qr/5']) {
    const response = await get(env, path);
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error, 'snapshot_stale');
    assert.equal(response.headers.get('x-bcsd-snapshot-observed-at'), String(value.observedAt));
    assert.equal(response.headers.get('x-bcsd-snapshot-age-ms'), '300001');
  }
});

test('PNG assets pass exact bytes with bounds and signature checks; optional Jam absence is not fabricated', async () => {
  const value = snapshot();
  for (const path of ['/api/wifi-qr/2.4', '/api/wifi-qr/5', '/api/jam-qr']) {
    const response = await get(environment(value), path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assertPrivate(response);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, 'base64'));
  }
  delete value.assets['/api/jam-qr'];
  assert.equal((await get(environment(value), '/api/jam-qr')).status, 404);
  for (const png of [
    '',
    'not-png',
    PNG + '\n',
    PNG.replace('iVBOR', 'AAAAA'),
    PNG.slice(0, -16) + 'AAAAAAAAAAAAAAAA',
    'iVBORw0KGgoA' + 'AAAA'.repeat(90_000),
  ]) {
    const invalid = snapshot();
    invalid.assets['/api/wifi-qr/5'] = png;
    assert.equal((await get(environment(invalid), '/api/wifi-qr/5')).status, 503);
  }
  const invalid = snapshot();
  invalid.assets['/api/camera'] = PNG;
  assert.equal((await get(environment(invalid))).status, 503);
});

test('SSE emits initial/version-change state and pings from atomic eventually-consistent KV reads', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const env = environment(snapshot(now));
  const response = await get(env, '/api/events');
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const decode = (chunk) => new TextDecoder().decode(chunk.value);
  assert.match(decode(await reader.read()), /event: state\ndata: \{"version":/);
  let pending = reader.read();
  t.mock.timers.tick(10_000);
  assert.equal(decode(await pending), 'event: ping\ndata: {}\n\n');
  const next = snapshot(Date.now());
  env.store.raw = JSON.stringify(next);
  pending = reader.read();
  t.mock.timers.tick(10_000);
  assert.equal(decode(await pending), `event: state\ndata: {"version":"${next.observedAt}:${next.publishedAt}"}\n\n`);
  assert.equal(env.store.reads, 3);
  await reader.cancel();
  t.mock.timers.tick(120_000);
  assert.equal(env.store.reads, 3);
});

test('SSE lifetime is at most sixty seconds even when unread', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const env = environment(snapshot(now));
  const response = await get(env, '/api/events');
  t.mock.timers.tick(60_000);
  assert.ok((await response.text()).startsWith('event: state\n'));
  const reads = env.store.reads;
  t.mock.timers.tick(120_000);
  assert.equal(env.store.reads, reads);
});

test('SSE closes when the atomic snapshot disappears instead of streaming stale/private payloads', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const env = environment(snapshot(now));
  const reader = (await get(env, '/api/events')).body.getReader();
  await reader.read();
  env.store.raw = null;
  const pending = reader.read();
  t.mock.timers.tick(10_000);
  assert.equal(
    new TextDecoder().decode((await pending).value),
    'event: unavailable\ndata: {"error":"snapshot_missing"}\n\n',
  );
  assert.equal((await reader.read()).done, true);
});

test('client disconnect cancels SSE timers and prevents any subsequent KV read', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const env = environment(snapshot(now));
  const client = new AbortController();
  const reader = (await get(env, '/api/events', ctx, { signal: client.signal })).body.getReader();
  await reader.read();
  const pending = reader.read();
  client.abort();
  assert.equal((await pending).done, true);
  t.mock.timers.tick(120_000);
  assert.equal(env.store.reads, 1);
  assert.equal((await get(env, '/api/events', ctx, { signal: client.signal })).status, 499);
  assert.equal(env.store.reads, 1);
});
