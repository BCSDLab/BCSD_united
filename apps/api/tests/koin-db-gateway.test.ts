import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiEnabled } from '@api/api-gate';
import gateway from '@api/koin-db/gateway';
import { memoryDining } from '@api/koin-db/tests/dining-fixture';
import type { Bindings } from '@api/runtime';

function env(): Bindings {
  const value = {
    ENVIRONMENT: 'preview',
    API_ENABLED: 'true',
    KOIN_DB_ENABLED: 'true',
    KOIN_DB_BRIDGE_TOKEN: 'test-only-bridge-token-with-32-characters',
    AUTH_ALLOWED_ORIGINS: 'https://stage.koreatech.in',
    DINING: memoryDining().namespace,
  } as Bindings;
  for (const key of ['DB', 'FILES', 'JOBS', 'COORDINATOR', 'COMMUNITY_CHAT']) {
    Object.defineProperty(value, key, {
      get() {
        throw new Error(`Unexpected D1 business access: ${key}`);
      },
    });
  }
  return value;
}

test('workers.dev without a production environment uses the stage Java origin', async (t) => {
  let target: string | undefined;
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    target = request.url;
    return new Response(null, { status: 204 });
  });
  const bindings = env();
  Reflect.deleteProperty(bindings, 'ENVIRONMENT');
  const response = await gateway.request('https://koin-api.workers.dev/users/me?key=one', {}, bindings);
  assert.equal(target, 'https://api.stage.koreatech.in/users/me?key=one');
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('X-Koin-Backend'), 'aws');
});

test('anonymous dining uses only the fixed authenticated HTTPS bridge', async (t) => {
  const bindings = env();
  bindings.ENVIRONMENT = 'production';
  bindings.KOIN_DB_BRIDGE_URL = 'https://api.koreatech.in/internal/edge/dinings';
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    seen.push(request);
    return Response.json([]);
  });
  const response = await gateway.request(
    'https://api.koreatech.in/dinings?date=261115&bridge=https://attacker.test',
    { headers: { Origin: 'https://stage.koreatech.in', 'X-Client-Secret': 'do-not-forward' } },
    bindings,
  );
  // 첫 적재: 식단 → (해당 날짜) MySQL 좋아요 가져오기. 둘 다 같은 고정 bridge다.
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.url, 'https://admin.koreatech.in/internal/edge/dining-likes?date=2026-11-15');
  assert.equal(seen[0]!.url, 'https://admin.koreatech.in/internal/edge/dinings?date=2026-11-15');
  assert.equal(seen[0]!.headers.get('X-Koin-Origin-Token'), bindings.KOIN_DB_BRIDGE_TOKEN);
  assert.equal(seen[0]!.headers.get('Authorization'), `Bearer ${bindings.KOIN_DB_BRIDGE_TOKEN}`);
  assert.equal(seen[0]!.headers.get('X-Client-Secret'), null);
  assert.equal(seen[0]!.headers.get('Origin'), null);
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.redirect, 'manual');
  assert.equal(response.headers.get('X-Koin-Backend'), 'workers');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://stage.koreatech.in');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), []);
});

const COOP = 'https://coop.koreatech.in';

function productionDining(extra?: string): Bindings {
  const bindings = env();
  bindings.ENVIRONMENT = 'production';
  bindings.KOIN_DB_BRIDGE_URL = 'https://api.koreatech.in/internal/edge/dinings';
  if (extra !== undefined) bindings.GATEWAY_CORS_ORIGINS = extra;
  return bindings;
}

test('dining CORS allows GATEWAY_CORS_ORIGINS without credentials and nothing else', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  // [요청 Origin, GATEWAY_CORS_ORIGINS, 기대 Allow-Origin, 기대 Allow-Credentials]
  const cases: [string, string | undefined, string | null, string | null][] = [
    // 영양사 웹은 Bearer 전용이라 Credentials 없이 출처만 허용된다. 설정이 없으면 차단된다.
    [COOP, COOP, COOP, null],
    [COOP, JSON.stringify([COOP]), COOP, null],
    [COOP, undefined, null, null],
    // 미등록 출처는 차단되고, 기존 웹 세션 출처는 Credentials까지 그대로 허용된다.
    ['https://evil.example', COOP, null, null],
    ['https://stage.koreatech.in', COOP, 'https://stage.koreatech.in', 'true'],
    // 웹 세션 출처가 보조 목록에도 있으면 더 넓은 쪽(Credentials 허용)이 유지된다.
    ['https://stage.koreatech.in', 'https://stage.koreatech.in', 'https://stage.koreatech.in', 'true'],
  ];
  for (const [origin, extra, allowOrigin, allowCredentials] of cases) {
    const response = await gateway.request(
      'https://api.koreatech.in/dinings?date=261115',
      { headers: { Origin: origin } },
      productionDining(extra),
    );
    const label = `${origin} / ${extra}`;
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get('X-Koin-Backend'), 'workers', label);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowOrigin, label);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), allowCredentials, label);
  }
});

test('CORS headers also accompany Workers error responses (401) for allowed origins', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  // 인증 없는 좋아요 쓰기는 Workers가 401로 답한다. 허용 출처의 브라우저가 상태 코드와 본문을 읽을 수 있어야 한다.
  const request = (origin: string) =>
    gateway.request(
      'https://api.koreatech.in/dining/like',
      { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"dining_id":1}' },
      productionDining(COOP),
    );
  const allowed = await request(COOP);
  assert.equal(allowed.status, 401);
  assert.equal(allowed.headers.get('X-Koin-Backend'), 'workers');
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), COOP);
  assert.equal(allowed.headers.get('Access-Control-Allow-Credentials'), null);
  const blocked = await request('https://evil.example');
  assert.equal(blocked.status, 401);
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
});

test('malformed origin settings: AUTH list fails closed with 503, GATEWAY list is ignored', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const headers = { Origin: 'https://stage.koreatech.in' };
  // 보조 목록(GATEWAY_CORS_ORIGINS) 오타는 기존 웹 출처의 식단 조회를 막지 않고, 해당 출처만 차단한다.
  for (const broken of ['[not-json', '{"a":1}', '[1,2]']) {
    const bindings = productionDining(broken);
    const web = await gateway.request('https://api.koreatech.in/dinings?date=261115', { headers }, bindings);
    assert.equal(web.status, 200, broken);
    assert.equal(web.headers.get('Access-Control-Allow-Origin'), 'https://stage.koreatech.in', broken);
    const coop = await gateway.request(
      'https://api.koreatech.in/dinings?date=261115',
      { headers: { Origin: COOP } },
      productionDining(broken),
    );
    assert.equal(coop.status, 200, broken);
    assert.equal(coop.headers.get('Access-Control-Allow-Origin'), null, broken);
  }
  // 웹 세션 출처(AUTH_ALLOWED_ORIGINS) 설정 오류는 기존대로 503이다.
  const bindings = productionDining(COOP);
  bindings.AUTH_ALLOWED_ORIGINS = '[not-json';
  const response = await gateway.request('https://api.koreatech.in/dinings?date=261115', { headers }, bindings);
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { code: string }).code, 'AUTH_CONFIGURATION_ERROR');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('Vary: Origin is added with or without an Origin header and keeps existing cache headers', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  for (const headers of [{}, { Origin: COOP }, { Origin: 'https://evil.example' }]) {
    const response = await gateway.request(
      'https://api.koreatech.in/dinings?date=261115',
      { headers },
      productionDining(COOP),
    );
    assert.match(response.headers.get('Vary') ?? '', /(^|,\s*)Origin(\s*,|$)/, JSON.stringify(headers));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  // Headers.append는 기존 Vary 값을 지우지 않고 이어 붙인다.
  const existing = new Headers({ Vary: 'Accept-Encoding' });
  existing.append('Vary', 'Origin');
  assert.equal(existing.get('Vary'), 'Accept-Encoding, Origin');
});

test('CORS preflight is not answered by Workers and goes to Java untouched', async (t) => {
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    seen.push(request);
    return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': COOP } });
  });
  for (const path of ['/dinings?date=261115', '/dining/like', '/coop/dining/soldout']) {
    seen.length = 0;
    const response = await gateway.request(
      `https://api.koreatech.in${path}`,
      { method: 'OPTIONS', headers: { Origin: COOP, 'Access-Control-Request-Method': 'GET' } },
      productionDining(COOP),
    );
    assert.equal(seen.length, 1, path);
    assert.equal(seen[0]!.method, 'OPTIONS', path);
    assert.equal(response.headers.get('X-Koin-Backend'), 'aws', path);
    // Workers는 preflight 응답에 CORS 헤더를 만들어 덧붙이지 않는다. Java 응답이 그대로 간다.
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), COOP, path);
    assert.equal(response.headers.has('Vary'), false, path);
  }
});

test('service-token, nonmigrated and internal bridge requests pass straight to Java', async (t) => {
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    seen.push(request);
    return Response.json([{ id: 1, is_liked: true }], {
      headers: { 'Access-Control-Allow-Origin': 'https://stage.koreatech.in' },
    });
  });
  for (const [path, credentials] of [
    ['/dinings?date=261115', { 'X-Koin-Service-Token': 'java-service-token' }],
    ['/shops', {}],
    ['/internal/edge/dinings?date=2026-11-15', {}],
  ] as const) {
    const response = await gateway.request(
      `https://koin-api.workers.dev${path}`,
      { headers: { ...credentials, Origin: 'https://stage.koreatech.in' } },
      env(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: 1, is_liked: true }]);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://stage.koreatech.in');
    assert.equal(response.headers.get('X-Koin-Backend'), 'aws');
    const forwarded = seen.at(-1)!;
    assert.equal(forwarded.url, `https://api.stage.koreatech.in${path}`);
    for (const [key, value] of Object.entries(credentials)) assert.equal(forwarded.headers.get(key), value);
    assert.equal(forwarded.redirect, 'manual');
    assert.notEqual(forwarded.headers.get('Authorization'), `Bearer ${env().KOIN_DB_BRIDGE_TOKEN}`);
  }
  assert.equal(seen.length, 3);
});

test('writes and preflight preserve method/body/status/cookies and never follow redirects', async (t) => {
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    seen.push(request);
    const headers = new Headers({ Location: '/next', 'X-Java': 'unchanged' });
    headers.append('Set-Cookie', 'first=1; Path=/; HttpOnly');
    headers.append('Set-Cookie', 'second=2; Path=/; Secure');
    return new Response('redirect body', { status: 307, headers });
  });
  const bindings = env();
  bindings.ENVIRONMENT = 'production';
  const response = await gateway.request(
    'https://api.koreatech.in/orders?key=one',
    {
      method: 'POST',
      body: '{"amount":1000}',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf', Cookie: 'session=java' },
    },
    bindings,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://admin.koreatech.in/_koin_api/orders?key=one');
  assert.equal(seen[0]!.headers.get('X-Koin-Origin-Token'), bindings.KOIN_DB_BRIDGE_TOKEN);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(await seen[0]!.text(), '{"amount":1000}');
  assert.equal(seen[0]!.headers.get('X-CSRF-Token'), 'csrf');
  assert.equal(seen[0]!.headers.get('Cookie'), 'session=java');
  assert.equal(seen[0]!.headers.get('Authorization'), null);
  assert.equal(seen[0]!.redirect, 'manual');
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('Location'), '/next');
  assert.equal(response.headers.get('X-Java'), 'unchanged');
  assert.deepEqual(response.headers.getSetCookie(), ['first=1; Path=/; HttpOnly', 'second=2; Path=/; Secure']);
  assert.equal(await response.text(), 'redirect body');
  await gateway.request('https://worker.example/dinings', { method: 'OPTIONS' }, bindings);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.method, 'OPTIONS');
  assert.equal(seen[1]!.headers.get('Authorization'), null);
});

test('missing credentials and unapproved bridge endpoints fail closed without any network or D1 fallback', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw new Error('Unexpected fallback');
  });
  for (const configuration of [
    { KOIN_DB_BRIDGE_TOKEN: undefined },
    { KOIN_DB_BRIDGE_TOKEN: 'short' },
    { KOIN_DB_BRIDGE_URL: 'http://api.stage.koreatech.in/internal/edge/dinings' },
    { KOIN_DB_BRIDGE_URL: 'https://attacker.test/internal/edge/dinings' },
    { KOIN_DB_BRIDGE_URL: 'https://api.stage.koreatech.in/internal/edge/dinings?date=2026-11-15' },
  ]) {
    const bindings = Object.assign(env(), configuration);
    assert.equal(isApiEnabled(bindings), false);
    const response = await gateway.request('https://worker.example/dinings?date=261115', {}, bindings);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object' && 'code' in body);
    assert.equal(body.code, 'KOIN_DB_UNAVAILABLE');
  }
  assert.equal(calls, 0);
});

test('bridge failure, redirects and malformed JSON never retry, fall back, or disclose bridge content', async (t) => {
  for (const failure of ['network', 'database', 'redirect', 'json', 'schema']) {
    await t.test(failure, async (context) => {
      let calls = 0;
      context.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (failure === 'network') throw new Error('private database details');
        if (failure === 'database') return new Response('private database details', { status: 503 });
        if (failure === 'redirect')
          return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } });
        if (failure === 'json') return new Response('private database details');
        return Response.json({ private: 'database details' });
      });
      const bindings = env();
      const response = await gateway.request('https://worker.example/dinings?date=261115', {}, bindings);
      assert.equal(calls, 1);
      assert.equal(response.status, failure === 'json' || failure === 'schema' ? 502 : 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const body = await response.text();
      assert.ok(!body.includes('private'));
      assert.ok(!body.includes(bindings.KOIN_DB_BRIDGE_TOKEN!));
    });
  }
});

test('failed Java write is sent once without bridge retry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('upstream connection lost');
  });
  const response = await gateway.request('https://worker.example/orders', { method: 'POST', body: 'payload' }, env());
  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('X-Koin-Backend'), 'aws');
});

test('response headers preserve WebSocket upgrade handles', async (t) => {
  const NativeResponse = globalThis.Response;
  t.mock.method(
    globalThis,
    'Response',
    class extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        if (init?.status === 101) {
          Object.defineProperties(this, {
            status: { value: 101 },
            webSocket: { value: init.webSocket },
          });
        }
      }
    },
  );
  const webSocket = {} as WebSocket;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 101, webSocket }));
  const response = await gateway.request('https://worker.example/socket', { headers: { Upgrade: 'websocket' } }, env());
  assert.equal(response.status, 101);
  assert.equal(response.webSocket, webSocket);
  assert.equal(response.headers.get('X-Koin-Backend'), 'aws');
});
