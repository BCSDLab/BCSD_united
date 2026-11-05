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
  createGateway,
  installOverlay,
  loadToken,
  removeOverlay,
  runStdioRequest,
  validateRequest,
} from './local-omp-gateway.mjs';

const TOKEN = 'a'.repeat(64);

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
