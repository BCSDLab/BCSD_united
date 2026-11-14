import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { connect } from 'node:net';
import {
  MAX_OUTPUT_BYTES,
  authorized,
  canonicalizeResponse,
  checkReadiness,
  childEnv,
  collectRockyHealth,
  cpuDelta,
  createGateway,
  distinctTokens,
  installOverlay,
  loadMonitorToken,
  loadToken,
  memoryReading,
  removeOverlay,
  runStdioRequest,
  unitReading,
  validateRequest,
} from './local-omp-gateway.mjs';

const TOKEN = 'a'.repeat(64);
const MONITOR_TOKEN = 'b'.repeat(64);

/** A stand-in for `omp auth-gateway stdio` driven by a small inline script. */
function fakeChild(script) {
  return () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
}

const HANGING_CHILD = `
  process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
  setInterval(() => {}, 1000);
`;

const FLOODING_CHILD = `
  process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
  const chunk = 'x'.repeat(65536);
  (function pump() { if (process.stdout.write(chunk)) setImmediate(pump); else process.stdout.once('drain', pump); })();
`;

test('token file must be a 0600 regular non-symlink file with a well-formed bearer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'token');
  await writeFile(file, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(await loadToken(file), TOKEN);
  await chmod(file, 0o640);
  await assert.rejects(loadToken(file), /0600/);
  await chmod(file, 0o600);
  await symlink(file, join(dir, 'link'));
  await assert.rejects(loadToken(join(dir, 'link')));
  await writeFile(join(dir, 'short'), 'too-short', { mode: 0o600 });
  await assert.rejects(loadToken(join(dir, 'short')), /32-512/);
  await assert.rejects(loadToken(''), /required/);
});

test('monitor bearer requires a private owned parent and must differ from the model bearer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-monitor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'monitor.token');
  await writeFile(file, MONITOR_TOKEN, { mode: 0o600 });
  assert.equal(await loadMonitorToken(file), MONITOR_TOKEN);
  assert.equal(distinctTokens(TOKEN, MONITOR_TOKEN), true);
  assert.equal(distinctTokens(TOKEN, TOKEN), false);
  assert.throws(() => createGateway({ token: TOKEN, monitorToken: TOKEN, log: () => {} }));
  await chmod(dir, 0o755);
  await assert.rejects(loadMonitorToken(file));
  await chmod(dir, 0o700);
  const link = `${dir}-link`;
  await symlink(dir, link);
  t.after(() => rm(link, { force: true }));
  await assert.rejects(loadMonitorToken(join(link, 'monitor.token')));
  await chmod(file, 0o644);
  await assert.rejects(loadMonitorToken(file));
});

test('the omp child gets a scrubbed environment and only the bridge retry overlay', async (t) => {
  assert.throws(() => childEnv({ PATH: '/bin' }, null), /overlay/);
  const file = await installOverlay();
  t.after(removeOverlay);
  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600);
  const env = childEnv({
    PATH: '/bin',
    HOME: '/home/x',
    LC_ALL: 'C',
    XDG_CONFIG_HOME: '/home/x/.config',
    OMP_AUTH_BROKER_URL: 'https://broker',
    PI_CONFIG_FILES: '/etc/user-overlay.yml',
    ANTHROPIC_API_KEY: 'sk-secret',
    ANTHROPIC_BASE_URL: 'https://evil.example',
    ANTHROPIC_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    OPENAI_API_KEY: 'sk-other',
    OMP_GATEWAY_TOKEN_FILE: '/private/token',
    OMP_GATEWAY_MONITOR_TOKEN_FILE: '/private/monitor',
  });
  assert.deepEqual(env, {
    PI_CONFIG_FILES: file,
    PATH: '/bin',
    HOME: '/home/x',
    LC_ALL: 'C',
    XDG_CONFIG_HOME: '/home/x/.config',
    OMP_AUTH_BROKER_URL: 'https://broker',
  });
});

test('readiness requires both exact provider-qualified models from omp', async () => {
  const listing = (ids) =>
    fakeChild(`
      process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
      let data = '';
      process.stdin.on('data', (c) => {
        data += c;
        if (!data.includes('\\n')) return;
        const { id, body } = JSON.parse(data);
        if (body !== undefined) throw new Error('readiness must be a GET');
        process.stdout.write(JSON.stringify({ id, status: 200, body: { object: 'list', data: ${JSON.stringify(ids)}.map((id) => ({ id })) } }) + '\\n');
      });
    `);
  assert.deepEqual(
    await checkReadiness({ spawnChild: listing(['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'x/y']) }),
    ['claude-sonnet-5-5', 'claude-opus-5-5'],
  );
  await assert.rejects(checkReadiness({ spawnChild: listing(['anthropic/claude-sonnet-5-5']) }), /claude-opus-5-5/);
  await assert.rejects(checkReadiness({ spawnChild: listing(['claude-sonnet-5-5', 'claude-opus-5-5']) }));
});

test('bearer comparison rejects prefixes, suffixes and other schemes', () => {
  assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorized(`Bearer ${TOKEN}b`, TOKEN), false);
  assert.equal(authorized(`Bearer ${TOKEN.slice(1)}`, TOKEN), false);
  assert.equal(authorized(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(authorized(undefined, TOKEN), false);
});

test('request validation pins the two exact models and refuses streaming, server tools and unknown fields', () => {
  const base = { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const { model: requested, outbound } = validateRequest({ ...base, model });
    assert.equal(requested, model);
    assert.equal(outbound.model, `anthropic/${model}`);
  }
  for (const body of [
    { ...base, model: 'anthropic/claude-opus-5-5' },
    { ...base, model: 'claude-fable-5-1' },
    { ...base, model: '@smol' },
    { ...base, model: 'claude-opus-5-5', stream: true },
    { ...base, model: 'claude-opus-5-5', max_tokens: 100_000 },
    { ...base, model: 'claude-opus-5-5', messages: [] },
    { ...base, model: 'claude-opus-5-5', max_tokens: 8193 },
    { ...base, model: 'claude-opus-5-5', tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { ...base, model: 'claude-opus-5-5', tools: [{ name: 'Read' }] },
    [],
    null,
  ])
    assert.throws(() => validateRequest(body));
});

test('responses are canonicalized to the requested model and upstream error text never leaks', () => {
  const content = [{ type: 'text', text: 'ok' }];
  const ok = canonicalizeResponse('claude-sonnet-5-5', 200, {
    type: 'message',
    model: 'anthropic/claude-sonnet-5-5',
    content,
    stop_reason: 'end_turn',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.model, 'claude-sonnet-5-5');
  assert.equal(
    canonicalizeResponse('claude-opus-5-5', 200, {
      type: 'message',
      model: 'anthropic/claude-sonnet-5-5',
      content,
      stop_reason: 'end_turn',
    }).status,
    502,
  );
  const failed = canonicalizeResponse('claude-opus-5-5', 502, {
    type: 'error',
    error: { type: 'upstream_error', message: '400 raw-http-request=/Users/someone/.omp/logs/private.json' },
  });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.body), /\.omp|Users/);
  const limited = canonicalizeResponse('claude-opus-5-5', 429, { type: 'error', error: { type: 'rate_limit_error' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.type, 'rate_limit_error');
  assert.equal(limited.headers['Retry-After'], undefined);
});

test('an aborted stdio request kills its own child', async () => {
  const controller = new AbortController();
  let child;
  const spawnChild = () => (child = fakeChild(HANGING_CHILD)());
  const pending = runStdioRequest({ path: '/v1/messages', body: {}, signal: controller.signal, spawnChild });
  await once(child.stdout, 'data');
  controller.abort(new Error('client disconnected'));
  await assert.rejects(pending, /aborted/);
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  assert.equal(child.signalCode, 'SIGKILL');
});

test('a child that floods stdout is killed at the output bound', async () => {
  let child;
  const spawnChild = () => (child = fakeChild(FLOODING_CHILD)());
  await assert.rejects(
    runStdioRequest({ path: '/v1/messages', body: {}, signal: new AbortController().signal, spawnChild }),
    /output bound/,
  );
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  assert.equal(child.signalCode, 'SIGKILL');
  assert.ok(MAX_OUTPUT_BYTES >= 4 * 1024 * 1024);
});

test('gateway authenticates before spawning, serves one request at a time and answers only POST /v1/messages', async (t) => {
  let spawns = 0;
  let release;
  const runRequest = ({ body, signal }) =>
    new Promise((resolve, reject) => {
      spawns += 1;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      release = () =>
        resolve({
          status: 200,
          body: { type: 'message', model: body.model, content: [], stop_reason: 'end_turn' },
        });
    });
  const server = createGateway({ token: TOKEN, runRequest, log: () => {} });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  const call = (path, init) => fetch(`${origin}${path}`, { method: 'POST', ...init });
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  assert.equal((await call('/v1/messages', { body: JSON.stringify(request) })).status, 401);
  assert.equal((await call('/v1/messages?x=1', { headers, body: JSON.stringify(request) })).status, 404);
  assert.equal((await call('/v1/chat/completions', { headers, body: JSON.stringify(request) })).status, 404);
  assert.equal((await fetch(`${origin}/v1/messages`, { headers })).status, 405);
  assert.equal(
    (await call('/v1/messages', { headers, body: JSON.stringify({ ...request, model: 'claude-fable-5-1' }) })).status,
    400,
  );
  assert.equal(spawns, 0);

  const first = call('/v1/messages', { headers, body: JSON.stringify(request) });
  while (spawns === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const busy = await call('/v1/messages', { headers, body: JSON.stringify(request) });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '5');
  assert.equal(spawns, 1);
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal((await done.json()).model, 'claude-opus-5-5');

  // A client that disconnects mid-request aborts the child and frees the slot.
  const controller = new AbortController();
  const dropped = call('/v1/messages', { headers, body: JSON.stringify(request), signal: controller.signal });
  while (spawns < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(dropped);
  // The freed slot admits the next request; a 503 here can only be the abort still unwinding.
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let after;
  for (let attempt = 0; attempt < 100 && !after; attempt += 1) {
    const expected = spawns + 1;
    const pending = call('/v1/messages', { headers, body: JSON.stringify(request) });
    const raced = await Promise.race([
      pending,
      (async () => {
        while (spawns < expected) await settle(5);
      })(),
    ]);
    if (raced === undefined) {
      release();
      after = await pending;
      break;
    }
    assert.equal(raced.status, 503);
    await raced.arrayBuffer();
    await settle(10);
  }
  assert.equal(after?.status, 200);
  assert.equal(spawns, 3);
});

/** Opens a raw connection and writes the request head plus `body` without finishing it. */
async function rawPost(port, headers, body) {
  const socket = connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.on('error', () => {});
  socket.write(
    `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n${headers}\r\n\r\n${body}`,
  );
  return socket;
}

function collect(socket) {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', () => resolve(data));
  });
}

test('a stalled or dropped request body never pins the single slot, and oversized chunked bodies are refused', async (t) => {
  let spawns = 0;
  const runRequest = ({ body }) => {
    spawns += 1;
    return Promise.resolve({
      status: 200,
      body: { type: 'message', model: body.model, content: [], stop_reason: 'end_turn' },
    });
  };
  const server = createGateway({ token: TOKEN, runRequest, timeoutMs: 150, log: () => {} });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const request = JSON.stringify({
    model: 'claude-sonnet-5-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const complete = async () => {
    const socket = await rawPost(port, `Content-Type: application/json\r\nContent-Length: ${request.length}`, request);
    return collect(socket);
  };

  // Stalled body: 504 arrives at the short deadline, the connection closes, and the next request runs.
  const stalled = await rawPost(port, 'Content-Type: application/json\r\nContent-Length: 500', request.slice(0, 20));
  const started = Date.now();
  const timedOut = await collect(stalled);
  assert.ok(Date.now() - started < 5_000);
  assert.match(timedOut, /^HTTP\/1\.1 504 /);
  assert.match(timedOut, /"type":"api_error"/);
  assert.equal(spawns, 0);
  assert.match(await complete(), /^HTTP\/1\.1 200 /);
  assert.equal(spawns, 1);

  // Dropped mid-body: nothing is spawned and the slot is released at once.
  const dropped = await rawPost(port, 'Content-Type: application/json\r\nContent-Length: 500', request.slice(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
  dropped.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(await complete(), /^HTTP\/1\.1 200 /);
  assert.equal(spawns, 2);

  // Oversized chunked body: 413 is answered as soon as the bound is crossed and the connection is closed.
  const chunk = 'x'.repeat(1024 * 1024 + 1);
  const chunked = await rawPost(port, 'Content-Type: application/json\r\nTransfer-Encoding: chunked', '');
  const refused = collect(chunked);
  chunked.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
  const tooLarge = await refused;
  assert.match(tooLarge, /^HTTP\/1\.1 413 /);
  assert.equal(spawns, 2);
  assert.match(await complete(), /^HTTP\/1\.1 200 /);
  assert.equal(spawns, 3);
});

test('Linux counters use a real two-sample busy delta and MemAvailable arithmetic', async () => {
  const first = 'cpu 100 10 20 70 10 5 5 0 9 3\n';
  const second = 'cpu 120 10 30 90 10 5 5 0 99 3\n';
  assert.deepEqual(cpuDelta(first, second, 1000, 1200), {
    usagePercent: 60,
    sampleStart: 1000,
    sampleEnd: 1200,
  });
  assert.deepEqual(memoryReading('MemTotal: 1000 kB\nMemAvailable: 400 kB\n', 1200), {
    totalBytes: 1024000,
    availableBytes: 409600,
    usedBytes: 614400,
    checkedAt: 1200,
  });
  const calls = [];
  let samples = 0;
  let clock = 1700000000000;
  const result = await collectRockyHealth({
    signal: new AbortController().signal,
    now: () => clock,
    platform: 'linux',
    sampleMs: 0,
    readProc: async (path) => {
      calls.push(path);
      if (path === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n';
      samples += 1;
      if (samples === 2) clock += 200;
      return samples === 1 ? first : second;
    },
    runSystemctl: async (name) => {
      calls.push(name);
      return name === 'koin-autofix-executor.service'
        ? 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n'
        : 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n';
    },
  });
  assert.deepEqual(
    calls.sort(),
    [
      '/proc/meminfo',
      '/proc/stat',
      '/proc/stat',
      'homebutler-auth-broker.service',
      'koin-autofix-executor.service',
    ].sort(),
  );
  assert.deepEqual(result, {
    version: 1,
    scope: 'rocky-read-only',
    checkedAt: 1700000000200,
    gateway: 'responding',
    cpu: { usagePercent: 60, sampleStart: 1700000000000, sampleEnd: 1700000000200 },
    memory: { totalBytes: 1024000, availableBytes: 409600, usedBytes: 614400, checkedAt: 1700000000000 },
    executor: { configured: true, state: 'active', process: 'running', checkedAt: 1700000000000 },
    broker: { configured: false, state: 'inactive', process: 'stopped', checkedAt: 1700000000000 },
    brokerResponse: 'not_probed',
    model: 'not_probed',
  });
});

test('counter resets, malformed memory and failed systemd reads stay unknown, not zero', async () => {
  assert.equal(cpuDelta('cpu 10 0 0 10 0 0 0 0\n', 'cpu 9 0 0 20 0 0 0 0\n', 1, 2), null);
  assert.equal(cpuDelta('cpu 10 0 0 10 0 0 0 0\n', 'cpu 10 0 0 10 0 0 0 0\n', 1, 2), null);
  const before = 'cpu 10 0 0 10 0 0 0 0\n';
  const after = 'cpu 20 0 0 20 0 0 0 0\n';
  assert.equal(cpuDelta(before, after, 1000, 1000), null);
  assert.equal(cpuDelta(before, after, 1001, 1000), null);
  assert.equal(cpuDelta(before, after, 1000, 11001), null);
  assert.equal(cpuDelta(before, after, Number.NaN, 1100), null);
  assert.equal(memoryReading('MemTotal: 100 kB\nMemAvailable: 101 kB\n', 2), null);
  assert.deepEqual(unitReading('LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n', 2), {
    configured: true,
    state: 'active',
    process: 'stopped',
    checkedAt: 2,
  });
  assert.deepEqual(unitReading('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=0\n', 2), {
    configured: true,
    state: 'active',
    process: 'unknown',
    checkedAt: 2,
  });
  const result = await collectRockyHealth({
    signal: new AbortController().signal,
    platform: 'linux',
    sampleMs: 0,
    now: () => 1234,
    readProc: async () => {
      throw new Error('/private/raw-path');
    },
    runSystemctl: async () => {
      throw new Error('sensitive systemctl output');
    },
  });
  assert.equal(result.cpu, null);
  assert.equal(result.memory, null);
  assert.deepEqual(result.executor, { configured: null, state: 'unknown', process: 'unknown', checkedAt: null });
  assert.deepEqual(result.broker, result.executor);
  assert.doesNotMatch(JSON.stringify(result), /private|sensitive|MainPID/);
});

test(
  'health route is exact, role-isolated, and remains responsive while the model slot is busy',
  { timeout: 5000 },
  async (t) => {
    let modelCalls = 0;
    let healthCalls = 0;
    const modelStarted = Promise.withResolvers();
    const modelRelease = Promise.withResolvers();
    const health = {
      version: 1,
      scope: 'rocky-read-only',
      checkedAt: 1234,
      gateway: 'responding',
      cpu: null,
      memory: null,
      executor: { configured: null, state: 'unknown', process: 'unknown', checkedAt: null },
      broker: { configured: null, state: 'unknown', process: 'unknown', checkedAt: null },
      brokerResponse: 'not_probed',
      model: 'not_probed',
    };
    const server = createGateway({
      token: TOKEN,
      monitorToken: MONITOR_TOKEN,
      log: () => {},
      collectHealth: async () => {
        healthCalls += 1;
        return health;
      },
      runRequest: ({ body }) => {
        modelCalls += 1;
        modelStarted.resolve();
        return modelRelease.promise.then(() => ({
          status: 200,
          body: { type: 'message', model: body.model, content: [], stop_reason: 'end_turn' },
        }));
      },
    });
    await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
    t.after(() => {
      modelRelease.resolve();
      server.closeAllConnections();
      server.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const modelHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const monitorHeaders = { Authorization: `Bearer ${MONITOR_TOKEN}` };
    const modelBody = JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const modelPost = (headers) => fetch(`${origin}/v1/messages`, { method: 'POST', headers, body: modelBody });
    assert.equal((await fetch(`${origin}/healthz`)).status, 401);
    assert.equal((await fetch(`${origin}/healthz`, { headers: modelHeaders })).status, 401);
    assert.equal((await modelPost(monitorHeaders)).status, 401);
    for (const path of ['/healthz?x=1', '/healthz/', '/HEALTHZ', '/unknown']) {
      assert.equal((await fetch(`${origin}${path}`, { headers: monitorHeaders })).status, 404);
    }
    const method = await fetch(`${origin}/healthz`, { method: 'POST', headers: monitorHeaders });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET');
    assert.equal(healthCalls, 0);
    assert.equal(modelCalls, 0);
    const pending = modelPost(modelHeaders);
    await modelStarted.promise;
    const reply = await fetch(`${origin}/healthz`, { headers: monitorHeaders });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), health);
    assert.equal(healthCalls, 1);
    assert.equal(modelCalls, 1);
    modelRelease.resolve();
    assert.equal((await pending).status, 200);
  },
);

test('unconfigured health returns 503 without changing model credential behavior', async (t) => {
  const server = createGateway({ token: TOKEN, log: () => {} });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/healthz`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 503);
  assert.equal((await fetch(`${origin}/healthz`, { method: 'POST' })).headers.get('allow'), 'GET');
});

test('health collector deadline aborts its work and frees the response', async (t) => {
  let aborted = false;
  const server = createGateway({
    token: TOKEN,
    monitorToken: MONITOR_TOKEN,
    healthTimeoutMs: 30,
    log: () => {},
    collectHealth: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, {
    headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
  });
  assert.equal(response.status, 504);
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
});

test('health deadline returns 504 even if an injected collector ignores abort', { timeout: 5000 }, async (t) => {
  let aborted = false;
  const server = createGateway({
    token: TOKEN,
    monitorToken: MONITOR_TOKEN,
    healthTimeoutMs: 30,
    log: () => {},
    collectHealth: ({ signal }) =>
      new Promise(() => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
      }),
  });
  await new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => server.close());
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, {
    headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
  });
  assert.equal(response.status, 504);
  assert.ok(Date.now() - started < 1000);
  assert.equal(aborted, true);
  assert.deepEqual(await response.json(), {
    type: 'error',
    error: { type: 'api_error', message: 'Health probe timed out' },
  });
});
