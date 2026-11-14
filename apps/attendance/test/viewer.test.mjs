import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewer } from '../src/viewer.ts';

const worker = createViewer('<main>readonly snapshot viewer</main>');
const NOW = Date.UTC(2026, 10, 14, 1);
const context = { access: { aud: 'private-app' } };
const paths = ['/api/state', '/api/monitor', '/api/koin-health', '/api/worker-health', '/api/spotify', '/api/jam'];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6t8sAAAAASUVORK5CYII=';
function snapshot(observedAt = NOW) {
  return {
    version: 1,
    observedAt,
    publishedAt: NOW,
    payloads: Object.fromEntries(paths.map((path) => [path, { status: 200, body: { path, measured: true } }])),
    assets: { '/api/wifi-qr/2.4': png, '/api/wifi-qr/5': png },
  };
}
function harness(value) {
  let reads = 0;
  const env = {
    CF_ACCESS_AUD: 'private-app',
    VIEW_STATE: {
      async get(key, format) {
        reads++;
        assert.equal(key, 'clubroom:view:v1');
        assert.equal(format, 'arrayBuffer');
        return value === null ? null : new TextEncoder().encode(JSON.stringify(value)).buffer;
      },
    },
  };
  const request = (path, options = {}, ctx = context) =>
    worker.fetch(new Request('https://viewer.example' + path, options), env, ctx);
  return { env, request, reads: () => reads };
}

test('the viewer rejects client-asserted authentication and mutations without reading attendance data', async () => {
  const h = harness(snapshot());
  assert.equal(
    (
      await h.request(
        '/api/state',
        { headers: { 'cf-access-jwt-assertion': 'forged', cookie: 'CF_Authorization=forged' } },
        {},
      )
    ).status,
    403,
  );
  assert.equal((await h.request('/api/state', {}, { access: { aud: 'other-app' } })).status, 403);
  for (const path of ['/api/taps', '/api/members', '/api/login', '/api/logout', '/api/camera'])
    assert.equal((await h.request(path, { method: 'POST' })).status, 404);
  assert.equal((await h.request('/api/state', { method: 'POST' })).status, 405);
  assert.equal((await h.request('/api/state?url=https://attacker.example')).status, 400);
  assert.equal(h.reads(), 0);
});

test('the freshness boundary does not hide an observed upstream failure', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const data = snapshot(NOW - 300000);
  data.payloads['/api/koin-health'] = { status: 503, body: { available: false } };
  const h = harness(data);
  const state = await h.request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('x-bcsd-snapshot-observed-at'), String(NOW - 300000));
  assert.equal(state.headers.get('cache-control'), 'private, no-store');
  const health = await h.request('/api/koin-health');
  assert.equal(health.status, 503);
});

test('missing, malformed and stale Pi snapshots fail closed while independent automation remains available', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  for (const value of [null, snapshot(NOW - 300001), { ...snapshot(), payloads: {} }]) {
    const h = harness(value);
    assert.equal((await h.request('/api/state')).status, 503);
    const status = await h.request('/api/view-status');
    assert.equal(status.status, 503);
    assert.equal((await status.json()).available, false);
    const before = h.reads();
    const monitor = await h.request('/api/automation');
    assert.equal(monitor.status, 200);
    const result = await monitor.json();
    assert.equal(result.state, 'unknown');
    assert.equal(result.data, null);
    assert.equal(result.rocky.state, 'unknown');
    assert.equal(h.reads(), before);
  }
});
