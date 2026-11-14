import assert from 'node:assert/strict';
import test, { before, after, mock } from 'node:test';
import { createInternalAuth, INTERNAL_SESSION_COOKIE } from '../src/internal-auth.ts';

const NOW = 1_800_000_000_000;
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzY29wZSI6IkFUVEVOREFOQ0UifQ.c2lnbmF0dXJl';
const LOGIN_URL = 'https://bcsd-attendance-auth.koreatech.in/v1/auth/attendance-login';
const SESSION_URL = 'https://bcsd-attendance-auth.koreatech.in/v1/members/attendance-session';
const ENV = {
  INTERNAL_AUTH_CLIENT_ID: 'isolated-client.access',
  INTERNAL_AUTH_CLIENT_SECRET: 'isolated-service-secret',
};
const CREDENTIALS = { studentNumber: '2023123456', password: '  isolated-password  ' };
const SESSION = { memberId: '42', name: '홍길동', expiresAt: NOW + 899_000 };
const COOKIE = `${INTERNAL_SESSION_COOKIE}=${TOKEN}`;

before(() => {
  mock.method(globalThis, 'fetch', () => assert.fail('Unexpected real network request'));
});
after(() => mock.restoreAll());

function request(path = '/api/me', options = {}) {
  return new Request(`https://attendance.example${path}`, {
    ...options,
    headers: { cookie: COOKIE, ...options.headers },
  });
}

function mutation(path = '/api/login', value = CREDENTIALS, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { origin: 'https://attendance.example', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });
}

function fixture(responses = [], overrides = {}) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, ...init, headers: new Headers(init.headers) });
    assert.ok(responses.length, 'Unexpected upstream request');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, init) : next;
  };
  const auth = createInternalAuth({ ...ENV, ...overrides }, { fetch: transport, now: () => NOW });
  return { auth, calls };
}

function loginPayload(change = {}) {
  return Response.json({ accessToken: TOKEN, tokenType: 'Bearer', expiresIn: 900, ...change });
}

async function assertSafeFailure(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const text = await response.text();
  for (const secret of [TOKEN, CREDENTIALS.password.trim(), ENV.INTERNAL_AUTH_CLIENT_SECRET, 'upstream-diagnostic']) {
    assert.equal(text.includes(secret), false);
  }
  assert.deepEqual(Object.keys(JSON.parse(text)), ['error']);
}

function cookieHeader(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  assert.match(header, /^__Host-attendance-session=/);
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(header.includes(attribute));
  assert.doesNotMatch(header, /Domain=/i);
  return header;
}

test('login uses only the two fixed broker paths and returns safe live metadata with an HttpOnly cookie', async () => {
  const { auth, calls } = fixture([loginPayload(), Response.json({ ...SESSION })]);
  const response = await auth.login(
    mutation('/api/login', CREDENTIALS, {
      authorization: 'Basic attacker',
      'cf-access-client-id': 'attacker-id',
      'cf-access-client-secret': 'attacker-secret',
      'x-forwarded-host': 'attacker.example',
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, ...SESSION, servedAt: NOW });
  assert.equal(cookieHeader(response), `${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=899`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, LOGIN_URL);
  assert.equal(calls[1].url, SESSION_URL);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.deepEqual(JSON.parse(calls[0].body), CREDENTIALS);
  assert.equal(calls[1].body, undefined);
  for (const call of calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.headers.get('cf-access-client-id'), ENV.INTERNAL_AUTH_CLIENT_ID);
    assert.equal(call.headers.get('cf-access-client-secret'), ENV.INTERNAL_AUTH_CLIENT_SECRET);
    assert.equal(call.headers.get('cookie'), null);
    assert.equal(call.headers.get('x-forwarded-host'), null);
    assert.equal(call.headers.get('accept'), 'application/json');
  }
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${TOKEN}`);
});

test('login never creates a browser session until the new token passes the real session endpoint', async () => {
  for (const status of [401, 403, 500, 302]) {
    const { auth, calls } = fixture([loginPayload(), new Response('upstream-diagnostic', { status })]);
    const response = await auth.login(mutation());
    await assertSafeFailure(response, status === 401 ? 401 : 503);
    assert.equal(calls.length, 2);
    assert.equal(response.headers.get('set-cookie')?.includes(TOKEN) ?? false, false);
  }
});

test('missing or malformed dedicated machine secrets fail closed without any fallback', async () => {
  for (const key of Object.keys(ENV)) {
    for (const value of [undefined, '', ' whitespace ', 'bad\r\nheader', 'x'.repeat(1025)]) {
      const { auth, calls } = fixture([], { [key]: value, BASIC_AUTH_PASSWORD: 'legacy', JWT_SECRET: 'legacy' });
      await assertSafeFailure(await auth.login(mutation()), 503);
      await assertSafeFailure(await auth.me(request()), 503);
      assert.equal(calls.length, 0);
    }
  }
});

test('bad credentials remain 401 while broker, rate-limit and network failures are generic 503', async () => {
  for (const status of [401, 400, 403, 429, 500, 503]) {
    const { auth, calls } = fixture([new Response('upstream-diagnostic', { status })]);
    await assertSafeFailure(await auth.login(mutation()), status === 401 ? 401 : 503);
    assert.equal(calls.length, 1);
  }
  const { auth } = fixture([
    () => {
      throw new Error('upstream-diagnostic');
    },
  ]);
  await assertSafeFailure(await auth.login(mutation()), 503);
});

test('login and logout require exact HTTPS same-Origin JSON before network or cookie changes', async () => {
  for (const method of ['login', 'logout']) {
    for (const headers of [
      { origin: '' },
      { origin: 'null' },
      { origin: 'https://attacker.example' },
      { origin: 'https://attendance.example/' },
      { 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/json; charset=iso-8859-1' },
    ]) {
      const { auth, calls } = fixture();
      const response = await auth[method](mutation(`/api/${method}`, method === 'logout' ? {} : CREDENTIALS, headers));
      assert.ok([400, 403].includes(response.status));
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(calls.length, 0);
    }
    const { auth, calls } = fixture();
    const response = await auth[method](
      new Request(`http://attendance.example/api/${method}`, {
        method: 'POST',
        headers: { origin: 'http://attendance.example', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    await assertSafeFailure(response, 403);
    assert.equal(calls.length, 0);
  }
});

test('method guards do not authenticate or mutate cookies', async () => {
  const { auth, calls } = fixture();
  for (const [handler, method, allow] of [
    ['login', 'GET', 'POST'],
    ['logout', 'GET', 'POST'],
    ['me', 'POST', 'GET'],
  ]) {
    const response = await auth[handler](request(`/api/${handler}`, { method }));
    await assertSafeFailure(response, 405);
    assert.equal(response.headers.get('allow'), allow);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(calls.length, 0);
});

test('invalid input, extra forwarding fields, invalid UTF-8 and byte bounds never reach Internal', async () => {
  const bodies = [
    {},
    [],
    null,
    { ...CREDENTIALS, studentNumber: '1234567' },
    { ...CREDENTIALS, studentNumber: '12345678901' },
    { ...CREDENTIALS, studentNumber: 2023123456 },
    { ...CREDENTIALS, password: '' },
    { ...CREDENTIALS, password: ' \n ' },
    { ...CREDENTIALS, password: 123 },
    { ...CREDENTIALS, target: 'https://attacker.example' },
  ].map((value) => JSON.stringify(value));
  bodies.push(
    '{',
    'x'.repeat(4097),
    JSON.stringify({ ...CREDENTIALS, password: '가'.repeat(1400) }),
    new Uint8Array([0xc3, 0x28]),
  );
  for (const body of bodies) {
    const { auth, calls } = fixture();
    const response = await auth.login(
      request('/api/login', {
        method: 'POST',
        headers: { origin: 'https://attendance.example', 'content-type': 'application/json' },
        body,
      }),
    );
    await assertSafeFailure(response, 400);
    assert.equal(calls.length, 0);
  }
  for (const headers of [
    { 'content-length': '4097' },
    { 'content-length': 'not-a-number' },
    { 'content-encoding': 'gzip' },
  ]) {
    const { auth, calls } = fixture();
    await assertSafeFailure(await auth.login(mutation('/api/login', CREDENTIALS, headers)), 400);
    assert.equal(calls.length, 0);
  }
});

test('request bounds apply across chunks rather than trusting Content-Length', async () => {
  const encoder = new TextEncoder();
  const { auth, calls } = fixture();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"studentNumber":"2023123456","password":"'));
      controller.enqueue(encoder.encode('x'.repeat(4096)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  await assertSafeFailure(
    await auth.login(
      request('/api/login', {
        method: 'POST',
        duplex: 'half',
        body,
        headers: { origin: 'https://attendance.example', 'content-type': 'application/json', 'content-length': '1' },
      }),
    ),
    400,
  );
  assert.equal(calls.length, 0);
});

test('malformed, duplicate, oversized and comma-folded app cookies fail closed before upstream', async () => {
  const malformed = [
    `${COOKIE}; ${COOKIE}`,
    `${INTERNAL_SESSION_COOKIE}=`,
    `${INTERNAL_SESSION_COOKIE}=not-a-jwt`,
    `${INTERNAL_SESSION_COOKIE}="${TOKEN}"`,
    `${INTERNAL_SESSION_COOKIE}=${TOKEN}%3Bother=x`,
    `${COOKIE}, other=x`,
    `${INTERNAL_SESSION_COOKIE}=${'x'.repeat(3501)}`,
    'other=' + 'x'.repeat(8193),
  ];
  for (const cookie of malformed) {
    const { auth, calls } = fixture();
    await assertSafeFailure(await auth.me(request('/api/me', { headers: { cookie } })), 401);
    await assertSafeFailure(await auth.login(mutation('/api/login', CREDENTIALS, { cookie })), 401);
    assert.equal(calls.length, 0);
  }
});

test('headers, legacy cookies and an absent session never replace the dedicated app cookie', async () => {
  const { auth, calls } = fixture();
  for (const cookie of [
    '',
    `CF_Authorization=${TOKEN}`,
    `attendance_session=${TOKEN}`,
    `__Secure-attendance-session=${TOKEN}`,
  ]) {
    await assertSafeFailure(
      await auth.me(
        request('/api/me', {
          headers: {
            cookie,
            authorization: `Bearer ${TOKEN}`,
            'cf-access-jwt-assertion': TOKEN,
            'cf-access-authenticated-user-email': 'member@example.test',
          },
        }),
      ),
      401,
    );
  }
  assert.equal(calls.length, 0);
});

test('syntactically valid forged JWT is checked by Internal, never locally authorized', async () => {
  const { auth, calls } = fixture([new Response(null, { status: 401 })]);
  const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiI0MiIsImV4cCI6OTk5OTk5OTk5OX0.Zm9yZ2Vk';
  const response = await auth.me(request('/api/me', { headers: { cookie: `${INTERNAL_SESSION_COOKIE}=${forged}` } }));
  await assertSafeFailure(response, 401);
  assert.equal(calls[0].url, SESSION_URL);
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${forged}`);
  assert.ok(cookieHeader(response).includes('Max-Age=0'));
});

test('every me and private-route verification observes live revocation instead of cached membership', async () => {
  const { auth, calls } = fixture([
    Response.json({ ...SESSION }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 401 }),
  ]);
  const first = await auth.me(request());
  assert.deepEqual(await first.json(), { authenticated: true, ...SESSION, servedAt: NOW });
  assert.equal(first.headers.get('set-cookie'), null);
  await assertSafeFailure(await auth.me(request()), 401);
  const guard = await auth.verify(request('/api/automation'));
  assert.equal(guard.ok, false);
  await assertSafeFailure(guard.response, 401);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === SESSION_URL));
});

test('verified-session result is token-free and provides the absolute SSE expiry boundary', async () => {
  const { auth } = fixture([Response.json({ ...SESSION, expiresAt: NOW + 12_345 })]);
  const result = await auth.verify(request('/api/events'));
  assert.deepEqual(result, { ok: true, session: { ...SESSION, expiresAt: NOW + 12_345 } });
  assert.equal(Math.min(NOW + 60_000, result.session.expiresAt), NOW + 12_345);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('invalid login contract cannot mint a session or fall back to another token type', async () => {
  for (const change of [
    { accessToken: '' },
    { accessToken: 'opaque' },
    { accessToken: 'a.b.c; injected=1' },
    { accessToken: 'a'.repeat(3501) + '.b.c' },
    { tokenType: 'Basic' },
    { tokenType: 'bearer' },
    { expiresIn: 901 },
    { expiresIn: 0 },
    { expiresIn: '900' },
    { email: 'directory@example.test' },
  ]) {
    const { auth, calls } = fixture([loginPayload(change)]);
    const response = await auth.login(mutation());
    await assertSafeFailure(response, 503);
    assert.equal(calls.length, 1);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('session requires the exact real Internal metadata contract and bounded live expiry', async () => {
  const invalid = [
    null,
    [],
    {},
    { ...SESSION, memberId: 42 },
    { ...SESSION, memberId: '' },
    { ...SESSION, memberId: '0' },
    { ...SESSION, name: '' },
    { ...SESSION, name: ' \n ' },
    { ...SESSION, name: 'name\u0000' },
    { ...SESSION, name: '가'.repeat(201) },
    { ...SESSION, expiresAt: NOW },
    { ...SESSION, expiresAt: NOW - 1 },
    { ...SESSION, expiresAt: NOW + 900_001 },
    { ...SESSION, expiresAt: NOW + 1.5 },
    { ...SESSION, expiresAt: String(SESSION.expiresAt) },
    { ...SESSION, active: true },
    { memberId: '42', name: '홍길동', email: 'member@example.test' },
  ];
  for (const value of invalid) {
    const { auth } = fixture([Response.json(value)]);
    await assertSafeFailure(await auth.me(request()), 503);
  }
});

test('redirects, unexpected effective URL and non-JSON upstream responses are never followed or exposed', async () => {
  const responses = [
    Response.redirect('https://attacker.example', 302),
    new Response('<html>upstream-diagnostic</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json; charset=iso-8859-1' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '8193' } }),
    new Response('x'.repeat(8193), { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
  ];
  const redirected = Response.json(SESSION);
  Object.defineProperty(redirected, 'redirected', { value: true });
  responses.push(redirected);
  const wrongUrl = Response.json(SESSION);
  Object.defineProperty(wrongUrl, 'url', { value: 'https://attacker.example/session' });
  responses.push(wrongUrl);
  for (const response of responses) {
    const { auth, calls } = fixture([response]);
    await assertSafeFailure(await auth.me(request()), 503);
    assert.equal(calls.length, 1);
  }
});

test('strict UTF-8 decoder supports multi-byte names split across upstream chunks', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(SESSION));
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset++) controller.enqueue(bytes.slice(offset, offset + 1));
      controller.close();
    },
  });
  const { auth } = fixture([new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8' } })]);
  assert.deepEqual(await auth.verify(request()), { ok: true, session: SESSION });
});

test('deadline includes upstream headers and aborts a transport ignoring cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const { auth } = fixture([
    (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  ]);
  const pending = auth.me(request());
  t.mock.timers.tick(5_000);
  await assertSafeFailure(await pending, 503);
  assert.equal(signal.aborted, true);
});

test('deadline covers complete upstream body and cancels a stalled reader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  let canceled = false;
  const body = new ReadableStream({
    pull() {
      entered.resolve();
      return new Promise(() => {});
    },
    cancel() {
      canceled = true;
    },
  });
  const { auth } = fixture([new Response(body, { headers: { 'content-type': 'application/json' } })]);
  const pending = auth.me(request());
  await entered.promise;
  t.mock.timers.tick(5_000);
  await assertSafeFailure(await pending, 503);
  assert.equal(canceled, true);
});

test('late transport success after timeout cannot issue a session cookie or start another request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const arrived = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  const { auth, calls } = fixture([
    () => {
      entered.resolve();
      return arrived.promise;
    },
  ]);
  const pending = auth.login(mutation());
  await entered.promise;
  t.mock.timers.tick(5_000);
  const result = await pending;
  await assertSafeFailure(result, 503);
  assert.equal(result.headers.get('set-cookie'), null);
  arrived.resolve(response);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(canceled, true);
});

test('bounded login request body times out without calling Internal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = false;
  const { auth, calls } = fixture();
  const pending = auth.login(
    request('/api/login', {
      method: 'POST',
      duplex: 'half',
      headers: { origin: 'https://attendance.example', 'content-type': 'application/json' },
      body: new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    }),
  );
  t.mock.timers.tick(5_000);
  await assertSafeFailure(await pending, 400);
  assert.equal(calls.length, 0);
  assert.equal(canceled, true);
});

test('client cancellation aborts session validation and fails closed', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  let signal;
  const { auth } = fixture([
    (_url, init) => {
      signal = init.signal;
      entered.resolve();
      return new Promise(() => {});
    },
  ]);
  const pending = auth.me(request('/api/me', { signal: controller.signal }));
  await entered.promise;
  controller.abort();
  await assertSafeFailure(await pending, 503);
  assert.equal(signal.aborted, true);
});

test('cookie age never exceeds 900 seconds and includes elapsed upstream time', async () => {
  let clock = NOW;
  const auth = createInternalAuth(ENV, {
    now: () => clock,
    fetch: async (url) => {
      if (url === LOGIN_URL) {
        clock += 1_200;
        return loginPayload();
      }
      assert.equal(url, SESSION_URL);
      clock += 2_400;
      return Response.json({ ...SESSION, expiresAt: NOW + 900_000 });
    },
  });
  const response = await auth.login(mutation());
  assert.equal(response.status, 200);
  assert.match(cookieHeader(response), /Max-Age=896$/);
  assert.deepEqual(await response.json(), {
    authenticated: true,
    ...SESSION,
    expiresAt: NOW + 900_000,
    servedAt: NOW + 3_600,
  });
});

test('logout clears only this app cookie, never calls Internal or writes attendance', async () => {
  const { auth, calls } = fixture();
  const response = await auth.logout(
    mutation('/api/logout', {}, { cookie: `${COOKIE}; CF_Authorization=outer-session` }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    cookieHeader(response),
    `${INTERNAL_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
  assert.deepEqual(await response.json(), { authenticated: false, servedAt: NOW });
  assert.equal(calls.length, 0);
  assert.equal(response.headers.get('set-cookie').includes('CF_Authorization'), false);
  const unconfigured = fixture([], { INTERNAL_AUTH_CLIENT_SECRET: undefined });
  assert.equal((await unconfigured.auth.logout(mutation('/api/logout', {}))).status, 200);
});

test('logout requires an empty bounded JSON object, including when app cookie is invalid', async () => {
  for (const body of [null, [], { memberId: '42' }, { password: CREDENTIALS.password }, 'x'.repeat(4097)]) {
    const { auth, calls } = fixture();
    const response = await auth.logout(mutation('/api/logout', body));
    await assertSafeFailure(response, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(calls.length, 0);
  }
  const { auth } = fixture();
  const response = await auth.logout(mutation('/api/logout', {}, { cookie: `${COOKIE}; ${COOKIE}` }));
  await assertSafeFailure(response, 401);
  assert.ok(cookieHeader(response).includes('Max-Age=0'));
});
