import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { syncDiningCache } from '@api/koin-db/dining';
import gateway from '@api/koin-db/gateway';
import { clearUserStatusCache } from '@api/koin-db/identity';
import { appTokenUserId, TokenError, webTokenClaims } from '@api/koin-db/jwt';
import type { Bindings } from '@api/runtime';
import {
  diningEnv,
  JWT_TEST_SECRET,
  memoryDining,
  memoryKv,
  memoryStore,
  mockUpstream,
  signToken,
  type BridgeData,
} from './tests/dining-fixture';

const DATE = '2026-11-15';
const NOW = Date.parse('2026-11-15T03:00:00Z');
const exp = Math.floor(NOW / 1000) + 600;
const row = (id: number, place: string) => ({
  id,
  date: DATE,
  type: 'LUNCH',
  place,
  price_card: 5000,
  price_cash: 5000,
  kcal: 700,
  menu: '["밥", "국"]',
  image_url: null,
  created_at: '2026-11-14 01:00:00',
  updated_at: '2026-11-14 01:00:00',
  sold_out: null,
  is_changed: null,
  likes: 99,
});
const users = new Map<number, unknown>([
  [7, { id: 7, user_type: 'STUDENT', is_deleted: false, is_authed: true }],
  [8, { id: 8, user_type: 'GENERAL', is_deleted: false, is_authed: true }],
  [9, { id: 9, user_type: 'COOP', is_deleted: false, is_authed: true }],
  [10, { id: 10, user_type: 'COUNCIL', is_deleted: false, is_authed: true }],
  [20, { id: 20, user_type: 'OWNER', is_deleted: false, is_authed: true }],
  [21, { id: 21, user_type: 'ADMIN', is_deleted: false, is_authed: true }],
  [22, { id: 22, user_type: 'STUDENT', is_deleted: false, is_authed: false }],
  [23, { id: 23, user_type: 'GENERAL', is_deleted: false, is_authed: false }],
  [24, { id: 24, user_type: 'STUDENT', is_deleted: true, is_authed: true }],
]);

// cron 1회 실행 뒤 상태: 날짜 DO 적재·좋아요 가져오기·ID 색인 완료.
async function world(t: TestContext, extra: Partial<BridgeData> = {}) {
  clearUserStatusCache();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { kv, store } = memoryKv();
  const objects = memoryDining(kv);
  const data: BridgeData = {
    dinings: new Map([[DATE, [row(1, 'A코스'), row(2, 'B코스')]]]),
    likes: new Map([
      [
        DATE,
        [
          { dining_id: 1, user_id: 100 },
          { dining_id: 2, user_id: 7 },
        ],
      ],
    ]),
    users,
    ...extra,
  };
  const requests = mockUpstream(t, data);
  const env = diningEnv({ DINING: objects.namespace, BATCH_KV: kv });
  await syncDiningCache(env, new Date(NOW));
  const call = (path: string, init: RequestInit = {}) =>
    gateway.request(`https://koin-api.workers.dev${path}`, init, env);
  return { env, objects, kv: store, requests, data, call };
}

const bearer = async (id: unknown, claims: Record<string, unknown> = {}) => ({
  Authorization: `Bearer ${await signToken({ id, exp, ...claims })}`,
});

async function error(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body.errorTraceId, 'string');
  return { status: response.status, code: body.code, message: body.message };
}

test('Java JWT key derivation, HS384 and claims rules', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  assert.equal(btoa(JWT_TEST_SECRET).length, 60);
  assert.equal(await appTokenUserId(JWT_TEST_SECRET, await signToken({ id: 7, exp })), 7);
  assert.equal(await appTokenUserId(JWT_TEST_SECRET, await signToken({ id: '7', exp })), 7);
  const rejects = async (token: string, verify: (secret: string, token: string) => Promise<unknown> = appTokenUserId) =>
    assert.rejects(verify(JWT_TEST_SECRET, token), TokenError);
  await rejects(await signToken({ id: 7, exp: Math.floor(NOW / 1000) - 1 }));
  await rejects(await signToken({ id: 7, exp, nbf: Math.floor(NOW / 1000) + 60 }));
  await rejects(await signToken({ id: 7, exp, web_session_id: 'session' }));
  await rejects(await signToken({ id: 7, exp, web_session_id: null }));
  await rejects(await signToken({ id: 'seven', exp }));
  await rejects(await signToken({ id: 2_147_483_648, exp }));
  await rejects(await signToken({ exp }));
  // 같은 키라도 Java가 발급하지 않는 알고리즘(HS256)과 다른 비밀키는 거부한다.
  await rejects(await signToken({ id: 7, exp }, { alg: 'HS256', hash: 'SHA-256' }));
  await rejects(await signToken({ id: 7, exp }, { secret: 'another-secret-of-forty-four-characters-long' }));
  const valid = await signToken({ id: 7, exp });
  const [head, , signature] = valid.split('.');
  const forged = btoa(JSON.stringify({ id: 8, exp })).replace(/=+$/, '');
  await rejects(`${head}.${forged}.${signature}`);
  await rejects(`${btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '')}.${forged}.`);
  await rejects('not-a-token');
  const web = await signToken({ id: 7, exp, web_session_id: 'session-1' });
  assert.deepEqual(await webTokenClaims(JWT_TEST_SECRET, web), { userId: 7, sessionId: 'session-1' });
  await rejects(web);
  await rejects(valid, webTokenClaims);
  await rejects(await signToken({ id: 7, exp, web_session_id: '  ' }), webTokenClaims);
});

test('GET /dinings: anonymous reads KV, Bearer adds is_liked from the date object with identical fields', async (t) => {
  const { call, objects, requests } = await world(t);
  const anonymous = await call('/dinings?date=261115');
  assert.equal(anonymous.status, 200);
  const anonymousBody = (await anonymous.json()) as Record<string, unknown>[];
  assert.deepEqual(
    anonymousBody.map((dining) => [dining.id, dining.likes, dining.is_liked]),
    [
      [1, 1, false],
      [2, 1, false],
    ],
  );
  await objects.flush();
  const before = requests.length;
  // KV 스냅샷만 읽는다(bridge·DO 미접근).
  assert.equal((await call('/dinings?date=261115')).status, 200);
  assert.equal(requests.length, before);

  const personal = await call('/dinings?date=261115', { headers: await bearer(7) });
  assert.equal(personal.headers.get('X-Koin-Backend'), 'workers');
  const body = (await personal.json()) as Record<string, unknown>[];
  assert.deepEqual(
    body.map((dining) => [dining.id, dining.is_liked]),
    [
      [1, false],
      [2, true],
    ],
  );
  assert.deepEqual(Object.keys(body[0]!), Object.keys(anonymousBody[0]!));
  assert.deepEqual({ ...body[1], is_liked: false }, anonymousBody[1]);
  // 잘못된·웹 토큰·Bearer 아닌 Authorization은 Java @UserId처럼 익명이다(오류 아님).
  for (const headers of [
    { Authorization: 'Bearer broken' },
    await bearer(7, { web_session_id: 'session' }),
    { Authorization: 'Basic abc' },
  ]) {
    const response = await call('/dinings?date=261115', { headers });
    assert.equal(response.status, 200);
    assert.ok(((await response.json()) as { is_liked: boolean }[]).every((dining) => !dining.is_liked));
  }
});

test('PATCH like/cancel follow Java order, messages and idempotency; counts and KV follow the object', async (t) => {
  const { call, objects, kv } = await world(t);
  const headers = await bearer(8);
  const like = (id: string, cancel = false, init: RequestInit = { headers }) =>
    call(`/dining/like${cancel ? '/cancel' : ''}?diningId=${id}`, { method: 'PATCH', ...init });

  const ok = await like('1');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '');
  assert.deepEqual(await error(await like('1')), {
    status: 409,
    code: '',
    message: "이미 좋아요를 누른 식단입니다! diningId: '1'userId: 8",
  });
  assert.deepEqual(await error(await like('999')), {
    status: 404,
    code: '',
    message: '존재하지 않는 메뉴입니다. menuId: 999',
  });
  assert.deepEqual(await error(await like('999', true)), {
    status: 404,
    code: '',
    message: "좋아요를 누른적이 없는 식단입니다! diningId: '999'userId: 8",
  });
  await objects.flush();
  const snapshot = JSON.parse(kv.get(`koin:dining:v1:${DATE}`)!) as { id: number; likes: number }[];
  assert.deepEqual(
    snapshot.map((dining) => dining.likes),
    [2, 1],
  );
  assert.equal((await like('1', true)).status, 200);
  assert.deepEqual((await error(await like('1', true))).status, 404);
  await objects.flush();
  assert.deepEqual(
    (JSON.parse(kv.get(`koin:dining:v1:${DATE}`)!) as { likes: number }[]).map((d) => d.likes),
    [1, 1],
  );

  // Spring 변환: 공백 제거·16진수·첫 값 허용, 누락·빈 값·숫자 아님은 Java 오류 그대로.
  assert.equal((await like(' 2 ')).status, 200);
  assert.equal((await like('0x1')).status, 200);
  assert.deepEqual(await error(await call('/dining/like', { method: 'PATCH', headers })), {
    status: 400,
    code: '',
    message: "Required request parameter 'diningId' for method parameter type Integer is not present",
  });
  assert.deepEqual(await error(await like('')), {
    status: 400,
    code: '',
    message: "Required request parameter 'diningId' for method parameter type Integer is present but converted to null",
  });
  for (const value of ['abc', '1.5', '2147483648', '%2B0x1']) {
    assert.deepEqual(await error(await like(value)), {
      status: 400,
      code: 'ILLEGAL_ARGUMENT',
      message: '잘못된 인자가 전달되었습니다.',
    });
  }
});

test('@Auth permit {GENERAL, STUDENT, COOP, COUNCIL}, authed/deleted rules and auth-before-parameter order', async (t) => {
  const { call } = await world(t);
  const patch = async (headers: Record<string, string>, path = '/dining/like?diningId=1') =>
    error(await call(path, { method: 'PATCH', headers }));
  const unauthorized = { status: 401, code: 'UNAUTHORIZED_USER', message: '인증이 필요합니다.' };
  for (const id of [7, 9, 10]) {
    assert.equal((await call('/dining/like?diningId=1', { method: 'PATCH', headers: await bearer(id) })).status, 200);
  }
  assert.deepEqual(await patch(await bearer(20)), {
    status: 403,
    code: 'FORBIDDEN_USER_TYPE',
    message: '인가되지 않은 유저 타입입니다.',
  });
  assert.deepEqual(await patch(await bearer(21)), {
    status: 403,
    code: 'FORBIDDEN_USER_TYPE',
    message: '인가되지 않은 유저 타입입니다.',
  });
  assert.deepEqual(await patch(await bearer(22)), {
    status: 403,
    code: 'FORBIDDEN_STUDENT',
    message: '아우누리에서 인증메일을 확인해주세요.',
  });
  assert.deepEqual(await patch(await bearer(23)), {
    status: 403,
    code: 'FORBIDDEN_ACCOUNT',
    message: '유효하지 않은 계정입니다.',
  });
  // User @Where(is_deleted=0): 탈퇴·없는 회원·임시 토큰(id 0)은 401.
  assert.deepEqual(await patch(await bearer(24)), unauthorized);
  assert.deepEqual(await patch(await bearer(404)), unauthorized);
  assert.deepEqual(await patch(await bearer(0)), unauthorized);
  assert.deepEqual(await patch({}), unauthorized);
  assert.deepEqual(await patch({ Authorization: 'Basic abc' }), unauthorized);
  assert.deepEqual(await patch({ Authorization: 'Bearer broken' }), unauthorized);
  assert.deepEqual(await patch(await bearer(7, { web_session_id: 'session' })), unauthorized);
  assert.deepEqual(await patch({}, '/dining/like?diningId=abc'), unauthorized);
});

test('concurrent like and cancel by the same user are serialized: exactly one succeeds each way', async (t) => {
  const { call, objects } = await world(t);
  const headers = await bearer(8);
  const burst = async (path: string) =>
    (await Promise.all(Array.from({ length: 12 }, () => call(path, { method: 'PATCH', headers })))).map(
      (r) => r.status,
    );
  const likes = await burst('/dining/like?diningId=1');
  assert.equal(likes.filter((status) => status === 200).length, 1);
  assert.equal(likes.filter((status) => status === 409).length, 11);
  assert.equal(objects.store(DATE).view(8).liked.length, 1);
  const cancels = await burst('/dining/like/cancel?diningId=1');
  assert.equal(cancels.filter((status) => status === 200).length, 1);
  assert.equal(cancels.filter((status) => status === 404).length, 11);
  assert.deepEqual(objects.store(DATE).view(8).liked, []);
  assert.equal(objects.store(DATE).view(null).rows[0]!.likes, 1);
});

test('import is token-protected, insert-or-ignore and keeps Worker-made likes', async (t) => {
  const { call, env, objects, data } = await world(t);
  const path = `/internal/workers/dining-likes/import?from=${DATE}&to=2026-11-16`;
  const auth = { Authorization: `Bearer ${env.KOIN_DB_BRIDGE_TOKEN}` };
  assert.equal((await call(path, { method: 'POST' })).status, 401);
  assert.equal((await call(path, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const first = await call(path, { method: 'POST', headers: auth });
  // cron 최초 적재가 이미 가져왔으므로 다시 실행해도 추가가 없다.
  assert.deepEqual(await first.json(), {
    ok: true,
    from: DATE,
    to: '2026-11-16',
    completed: '2026-11-16',
    failed: null,
    inserted: 0,
  });
  assert.equal((await call('/dining/like?diningId=1', { method: 'PATCH', headers: await bearer(8) })).status, 200);
  data.likes!.set(DATE, [...data.likes!.get(DATE)!, { dining_id: 1, user_id: 101 }]);
  const second = await call(path, { method: 'POST', headers: auth });
  assert.equal(((await second.json()) as { inserted: number }).inserted, 1);
  const third = await call(path, { method: 'POST', headers: auth });
  assert.equal(((await third.json()) as { inserted: number }).inserted, 0);
  assert.deepEqual(
    objects
      .store(DATE)
      .view(null)
      .rows.map((dining) => dining.likes),
    [3, 1],
  );
  const tooLong = await call(`/internal/workers/dining-likes/import?from=2026-01-01&to=2026-12-31`, {
    method: 'POST',
    headers: auth,
  });
  assert.equal(tooLong.status, 400);
});

test('store-level import idempotency and like/cancel before import', () => {
  const store = memoryStore();
  store.sync(DATE, [row(1, 'A코스') as never], NOW);
  assert.equal(store.like(5, 1), 'NOT_READY');
  assert.deepEqual(
    store.importLikes([
      { dining_id: 1, user_id: 5 },
      { dining_id: 1, user_id: 5 },
    ]),
    { inserted: 1 },
  );
  assert.deepEqual(store.importLikes([{ dining_id: 1, user_id: 5 }]), { inserted: 0 });
  assert.equal(store.like(5, 1), 'DUPLICATE_LIKE');
  // 메뉴가 사라져도 좋아요는 남는다(Java: 중복 검사 → 메뉴 조회 순서).
  store.sync(DATE, [], NOW);
  assert.equal(store.like(5, 1), 'DUPLICATE_LIKE');
  assert.equal(store.cancel(5, 1), 'MENU_NOT_FOUND');
  assert.equal(store.like(6, 1), 'MENU_NOT_FOUND');
  assert.throws(() => store.sync('2026-11-16', [], NOW), /date mismatch/);
});

test('web cookie: Java session probe decides identity, origin and CSRF; Authorization header disables cookies', async (t) => {
  const cookie = await signToken({ id: 7, exp, web_session_id: 'session-1' });
  const csrf = 'A'.repeat(43) + '.' + 'B'.repeat(43);
  const probes: Request[] = [];
  let session: Response | ((request: Request) => Response) = () =>
    Response.json({ authenticated: true, user_type: 'STUDENT', csrf_token: csrf });
  const { call } = await world(t, {
    session: (request) => {
      probes.push(request);
      return typeof session === 'function' ? session(request) : session;
    },
  });
  const headers = {
    Cookie: `analytics=1; __Secure-koin-stage-web-access=${cookie}; __Secure-koin-stage-web-csrf=${csrf}`,
    Origin: 'https://stage.koreatech.in',
  };
  const read = await call('/dinings?date=261115', { headers });
  assert.deepEqual(
    ((await read.json()) as { is_liked: boolean }[]).map((dining) => dining.is_liked),
    [false, true],
  );
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.url, 'https://api.stage.koreatech.in/v2/web/auth/session');
  assert.equal(probes[0]!.headers.get('Cookie'), `__Secure-koin-stage-web-access=${cookie}`);
  assert.equal(probes[0]!.headers.get('Origin'), 'https://stage.koreatech.in');
  assert.equal(probes[0]!.method, 'GET');

  const like = (extra: Record<string, string> = {}) =>
    call('/dining/like?diningId=1', { method: 'PATCH', headers: { ...headers, ...extra } });
  assert.deepEqual(await error(await like()), {
    status: 403,
    code: 'INVALID_CSRF_TOKEN',
    message: '올바르지 않은 CSRF 토큰입니다.',
  });
  assert.deepEqual((await error(await like({ 'X-CSRF-Token': csrf.replace('A', 'C') }))).code, 'INVALID_CSRF_TOKEN');
  assert.equal((await like({ 'X-CSRF-Token': csrf })).status, 200);

  session = Response.json({ code: 'FORBIDDEN_WEB_ORIGIN' }, { status: 403 });
  assert.deepEqual(await error(await like({ 'X-CSRF-Token': csrf })), {
    status: 403,
    code: 'FORBIDDEN_WEB_ORIGIN',
    message: '허용되지 않은 웹 요청입니다.',
  });
  assert.equal((await call('/dinings?date=261115', { headers })).status, 403);

  // 로그아웃·만료된 세션: 조회는 익명, 쓰기는 401.
  session = () => Response.json({ authenticated: false, user_type: null, csrf_token: null });
  const anonymous = await call('/dinings?date=261115', { headers });
  assert.ok(((await anonymous.json()) as { is_liked: boolean }[]).every((dining) => !dining.is_liked));
  assert.equal((await like({ 'X-CSRF-Token': csrf })).status, 401);

  // 로컬 서명 검증 실패·중복 쿠키는 Java에 묻지 않는다. Authorization이 있으면 쿠키를 보지 않는다.
  const count = probes.length;
  const forged = `${headers.Cookie.replace(cookie, `${cookie}x`)}`;
  assert.equal(
    (await call('/dining/like?diningId=1', { method: 'PATCH', headers: { ...headers, Cookie: forged } })).status,
    401,
  );
  const duplicate = `${headers.Cookie}; __Secure-koin-stage-web-access=${cookie}`;
  assert.equal(
    (await call('/dining/like?diningId=1', { method: 'PATCH', headers: { ...headers, Cookie: duplicate } })).status,
    401,
  );
  assert.equal(
    (await call('/dining/like?diningId=1', { method: 'PATCH', headers: { ...headers, Authorization: 'Basic x' } }))
      .status,
    401,
  );
  assert.equal(probes.length, count);
});

test('missing Durable Object or JWT secret fails closed with 503', async (t) => {
  const { env } = await world(t);
  for (const binding of ['DINING', 'KOIN_JWT_SECRET'] as const) {
    const bindings = { ...env, [binding]: undefined } as Bindings;
    const response = await gateway.request(
      'https://koin-api.workers.dev/dining/like?diningId=1',
      { method: 'PATCH', headers: await bearer(8) },
      bindings,
    );
    assert.equal(response.status, 503);
  }
});
