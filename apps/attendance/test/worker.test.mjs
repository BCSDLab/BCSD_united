import assert from 'node:assert/strict';
import test, { before, after, mock } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../src/viewer.ts';
import { buildViewer } from '../scripts/build-viewer.mjs';

const AUD = 'isolated-viewer-test-audience';
const ctx = { access: { aud: AUD } };
const SESSION_TOKEN = 'a.b.c';
const SESSION_COOKIE = `__Host-attendance-session=${SESSION_TOKEN}`;
const AUTH_ENV = {
  INTERNAL_AUTH_CLIENT_ID: 'isolated-viewer-client',
  INTERNAL_AUTH_CLIENT_SECRET: 'isolated-viewer-secret',
};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTyoAAAAASUVORK5CYII=';
const jsonPaths = ['/api/state', '/api/monitor', '/api/koin-health', '/api/worker-health', '/api/spotify', '/api/jam'];
const paths = [
  '/',
  '/health',
  '/api/events',
  '/api/view-status',
  ...jsonPaths,
  '/api/automation',
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
  worker = createViewer(html, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://bcsd-attendance-auth.koreatech.in/v1/members/attendance-session');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${SESSION_TOKEN}`);
      return Response.json({ memberId: '42', name: '홍길동', expiresAt: Date.now() + 899_000 });
    },
  });
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
  return { store, CF_ACCESS_AUD: AUD, VIEW_STATE: store, ...AUTH_ENV };
}
function get(env, path = '/api/state', context = ctx, options = {}) {
  return worker.fetch(
    new Request(`https://attendance.example${path}`, {
      ...options,
      headers: { cookie: SESSION_COOKIE, ...options.headers },
    }),
    env,
    context,
  );
}
function assertPrivate(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-bcsd-view-mode'), 'eventually-consistent-snapshot');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.match(response.headers.get('content-security-policy'), /img-src [^;]*\bblob:/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self';/);
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin', 'www-authenticate'])
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
  const legacy = { ATTENDANCE: environment().store, CF_ACCESS_AUD: AUD, ...AUTH_ENV };
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
    servedAt: now,
  });
  t.mock.timers.tick(300_001);
  const stale = await get(env, '/api/view-status');
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), {
    available: false,
    observedAt: value.observedAt,
    publishedAt: value.publishedAt,
    ageMs: 301001,
    servedAt: now + 300_001,
  });
  assert.equal(stale.headers.get('x-bcsd-snapshot-observed-at'), String(value.observedAt));
  env.store.raw = null;
  const missing = await get(env, '/api/view-status');
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), {
    available: false,
    observedAt: null,
    publishedAt: null,
    ageMs: null,
    servedAt: now + 300_001,
  });
  assert.equal(missing.headers.get('x-bcsd-snapshot-observed-at'), null);
  env.VIEW_STATE = undefined;
  assert.equal((await get(env, '/')).status, 200);
  assert.equal((await get(env, '/api/view-status')).status, 503);
});

test('camera/auth/admin/writes/arbitrary paths/queries and non-root HEAD never read KV', async () => {
  const env = environment();
  for (const path of [
    '/api/taps',
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
      cookie: `${SESSION_COOKIE}; private-cookie=value`,
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

test('native platform context gates all auth endpoints before any Internal or data calls', async () => {
  let upstream = 0;
  const guarded = createViewer(html, {
    fetch: async () => {
      upstream++;
      throw new Error('unexpected transport');
    },
  });
  const env = environment();
  for (const path of ['/api/login', '/api/me', '/api/logout']) {
    const mutation = path !== '/api/me';
    const response = await guarded.fetch(
      new Request(`https://attendance.example${path}`, {
        method: mutation ? 'POST' : 'GET',
        headers: {
          cookie: SESSION_COOKIE,
          authorization: 'Basic attacker',
          origin: 'https://attendance.example',
          'content-type': 'application/json',
        },
        body: mutation ? '{}' : undefined,
      }),
      env,
      {},
    );
    assert.equal(response.status, 403);
    assertPrivate(response);
  }
  assert.equal(upstream, 0);
  assert.equal(env.store.reads, 0);
});

test('login, live me and local logout preserve private response headers without exposing JWTs or reading KV', async () => {
  const seen = [];
  const expiresAt = Date.now() + 800_000;
  const guarded = createViewer(html, {
    fetch: async (url, init) => {
      seen.push(url);
      if (url.endsWith('/attendance-login')) {
        assert.deepEqual(JSON.parse(init.body), { studentNumber: '20231234', password: 'isolated password' });
        return Response.json({ accessToken: SESSION_TOKEN, tokenType: 'Bearer', expiresIn: 900 });
      }
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${SESSION_TOKEN}`);
      return Response.json({ memberId: '42', name: '홍길동', expiresAt });
    },
  });
  const env = environment();
  const send = (path, body) =>
    guarded.fetch(
      new Request(`https://attendance.example${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { cookie: SESSION_COOKIE, origin: 'https://attendance.example', 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      ctx,
    );
  for (const response of [
    await send('/api/login', { studentNumber: '20231234', password: 'isolated password' }),
    await send('/api/me'),
  ]) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['authenticated', 'expiresAt', 'memberId', 'name', 'servedAt']);
    assert.equal(body.authenticated, true);
    assert.equal(body.expiresAt, expiresAt);
    assert.equal(body.memberId, '42');
    assert.equal(body.name, '홍길동');
    assert.equal(typeof body.servedAt, 'number');
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(response.headers.get('content-security-policy'));
  }
  const logout = await send('/api/logout', {});
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((url) => url.startsWith('https://bcsd-attendance-auth.koreatech.in/v1/')));
  assert.equal(env.store.reads, 0);
});

test('all private Pi and automation routes require live Internal membership before KV or service reads', async () => {
  for (const status of [401, 503]) {
    let authReads = 0;
    let serviceReads = 0;
    const guarded = createViewer(html, {
      fetch: async (url) => {
        assert.equal(url, 'https://bcsd-attendance-auth.koreatech.in/v1/members/attendance-session');
        authReads++;
        return new Response(null, { status });
      },
    });
    const env = environment();
    env.ERROR_AUTOMATION = {
      fetch: async () => {
        serviceReads++;
        throw new Error('must not read');
      },
    };
    env.ERROR_MONITOR_TOKEN = 'm'.repeat(32);
    for (const path of paths.filter((path) => path !== '/')) {
      const response = await guarded.fetch(
        new Request(`https://attendance.example${path}`, {
          headers: { cookie: SESSION_COOKIE },
        }),
        env,
        ctx,
      );
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('www-authenticate'), null);
    }
    assert.equal(authReads, paths.length - 1);
    assert.equal(env.store.reads, 0);
    assert.equal(serviceReads, 0);
  }
  const env = environment();
  for (const path of paths.filter((path) => path !== '/')) {
    const response = await worker.fetch(
      new Request(`https://attendance.example${path}`, {
        headers: { authorization: 'Basic attacker', cookie: 'CF_Authorization=forged' },
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 401, path);
  }
  assert.equal(env.store.reads, 0);
});

test('static root and HEAD never validate membership or read private data, even without machine secrets', async () => {
  const guarded = createViewer('<main>login shell</main>', {
    fetch: async () => assert.fail('root must not call Internal'),
  });
  const env = environment();
  delete env.INTERNAL_AUTH_CLIENT_ID;
  delete env.INTERNAL_AUTH_CLIENT_SECRET;
  for (const method of ['GET', 'HEAD']) {
    const response = await guarded.fetch(new Request('https://attendance.example/', { method }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), method === 'GET' ? '<main>login shell</main>' : '');
  }
  assert.equal(env.store.reads, 0);
});

test('pending membership validation cannot race ahead into snapshot reads', async () => {
  const entered = Promise.withResolvers();
  const validation = Promise.withResolvers();
  const guarded = createViewer(html, {
    fetch: async () => {
      entered.resolve();
      return validation.promise;
    },
  });
  const env = environment();
  const pending = guarded.fetch(
    new Request('https://attendance.example/api/state', { headers: { cookie: SESSION_COOKIE } }),
    env,
    ctx,
  );
  await entered.promise;
  assert.equal(env.store.reads, 0);
  validation.resolve(Response.json({ memberId: '42', name: '홍길동', expiresAt: Date.now() + 899_000 }));
  assert.equal((await pending).status, 200);
  assert.equal(env.store.reads, 1);
});

test('SSE revalidates current membership before each poll and stops revoked sessions before KV reads', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let authReads = 0;
  const guarded = createViewer(html, {
    fetch: async () => {
      authReads++;
      return authReads === 1
        ? Response.json({ memberId: '42', name: '홍길동', expiresAt: now + 899_000 })
        : new Response(null, { status: 401 });
    },
  });
  const env = environment(snapshot(now));
  const response = await guarded.fetch(
    new Request('https://attendance.example/api/events', { headers: { cookie: SESSION_COOKIE } }),
    env,
    ctx,
  );
  const reader = response.body.getReader();
  await reader.read();
  const closed = reader.read();
  t.mock.timers.tick(10_000);
  assert.equal((await closed).done, true);
  assert.equal(authReads, 2);
  assert.equal(env.store.reads, 1);
  t.mock.timers.tick(120_000);
  assert.equal(authReads, 2);
  assert.equal(env.store.reads, 1);
});

test('SSE closes at Internal expiry even when unread and without another private read', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let authReads = 0;
  const guarded = createViewer(html, {
    fetch: async () => {
      authReads++;
      return Response.json({ memberId: '42', name: '홍길동', expiresAt: now + 5_000 });
    },
  });
  const env = environment(snapshot(now));
  const response = await guarded.fetch(
    new Request('https://attendance.example/api/events', { headers: { cookie: SESSION_COOKIE } }),
    env,
    ctx,
  );
  t.mock.timers.tick(5_000);
  assert.match(await response.text(), /^event: state/);
  t.mock.timers.tick(120_000);
  assert.equal(authReads, 1);
  assert.equal(env.store.reads, 1);
});

test('a snapshot finishing after session expiry never returns its private payload', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const guarded = createViewer(html, {
    fetch: async () => Response.json({ memberId: '42', name: '홍길동', expiresAt: now + 1_000 }),
  });
  const env = environment(snapshot(now));
  env.store.get = async () => {
    t.mock.timers.tick(1_000);
    return new TextEncoder().encode(JSON.stringify(snapshot(now))).buffer;
  };
  const response = await guarded.fetch(
    new Request('https://attendance.example/api/state', { headers: { cookie: SESSION_COOKIE } }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'authentication_required');
});

test('SSE revalidation can shorten but never extend the original expiry before the next KV read', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let authReads = 0;
  const guarded = createViewer(html, {
    fetch: async () => {
      authReads++;
      return Response.json({ memberId: '42', name: '홍길동', expiresAt: now + (authReads === 1 ? 50_000 : 12_000) });
    },
  });
  const env = environment(snapshot(now));
  const response = await guarded.fetch(
    new Request('https://attendance.example/api/events', { headers: { cookie: SESSION_COOKIE } }),
    env,
    ctx,
  );
  const reader = response.body.getReader();
  await reader.read();
  const ping = reader.read();
  t.mock.timers.tick(10_000);
  assert.equal(new TextDecoder().decode((await ping).value), 'event: ping\ndata: {}\n\n');
  assert.equal(env.store.reads, 2);
  const closed = reader.read();
  t.mock.timers.tick(2_000);
  assert.equal((await closed).done, true);
  t.mock.timers.tick(120_000);
  assert.equal(authReads, 2);
  assert.equal(env.store.reads, 2);
});
