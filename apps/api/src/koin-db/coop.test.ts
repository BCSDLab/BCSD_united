import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { clearCoopOpensCache, diningPushMessage, openedAt } from '@api/koin-db/coop-notify';
import {
  encodeImagePath,
  kstOffsetTime,
  kstWallToMs,
  type DiningMeta,
  type OutboxJob,
  type Outcome,
} from '@api/koin-db/coop-store';
import { syncDiningCache } from '@api/koin-db/dining';
import gateway from '@api/koin-db/gateway';
import { clearUserStatusCache } from '@api/koin-db/identity';
import type { Bindings } from '@api/runtime';
import { diningEnv, memoryCoopStore, memoryDining, memoryKv, signToken } from './tests/dining-fixture';

const DATE = '2026-11-15'; // 일요일
const NOW = Date.parse('2026-11-15T03:00:00Z'); // KST 12:00
const exp = Math.floor(NOW / 1000) + 86_400;
const BOT_TOKEN = 'bot-service-token';
const PREFIX = 'https://stage-static.koreatech.in/';
const IMAGE = `${PREFIX}upload/COOP/2026/11/15/uuid/soldout photo+1.jpg`;

type BridgeDining = Record<string, unknown> & { id: number; menu: string };
const row = (id: number, place: string, type = 'LUNCH', extra: Record<string, unknown> = {}): BridgeDining => ({
  id,
  date: DATE,
  type,
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
  ...extra,
});
const users = new Map<number, unknown>([
  [7, { id: 7, user_type: 'STUDENT', is_deleted: false, is_authed: true }],
  [8, { id: 8, user_type: 'STUDENT', is_deleted: false, is_authed: true }],
  [9, { id: 9, user_type: 'COOP', is_deleted: false, is_authed: true }],
  [10, { id: 10, user_type: 'GENERAL', is_deleted: false, is_authed: true }],
  [21, { id: 21, user_type: 'ADMIN', is_deleted: false, is_authed: true }],
  [22, { id: 22, user_type: 'ADMIN', is_deleted: false, is_authed: false }],
]);
const opens = {
  semester_id: 1,
  coop_name_id: 2,
  shop_id: 3,
  opens: [
    { day_of_week: 'WEEKEND', type: '점심', open_time: '11:00', close_time: '14:00' },
    { day_of_week: 'WEEKEND', type: '저녁', open_time: '17:00', close_time: '19:00' },
  ],
};

interface FcmMessage {
  token: string;
  android: { data: Record<string, string> };
  apns: Record<string, unknown>;
}
interface Upstream {
  dinings: Map<string, BridgeDining[]>;
  images: Set<string>;
  opens: unknown;
  targets: unknown[];
  fcm: FcmMessage[];
  bridge: string[];
  import?: Record<string, unknown[][]>;
  sequence?: number;
}

function mockFetch(t: TestContext, upstream: Upstream) {
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'oauth', expires_in: 3600 });
    if (url.hostname === 'fcm.googleapis.com') {
      const body: { message: FcmMessage } = await request.json();
      upstream.fcm.push(body.message);
      return Response.json({ name: 'projects/p/messages/1' });
    }
    if (url.origin === PREFIX.slice(0, -1)) {
      const exists = upstream.images.has(decodeURIComponent(url.href));
      if (request.method === 'HEAD') return new Response(null, { status: exists ? 200 : 403 });
      return exists
        ? new Response(new TextEncoder().encode(`bytes:${url.pathname}`))
        : new Response(null, { status: 404 });
    }
    const resource = url.pathname.replace('/internal/edge/', '');
    upstream.bridge.push(`${resource}${url.search}`);
    const query = url.searchParams;
    switch (resource) {
      case 'dinings':
        return Response.json(upstream.dinings.get(query.get('date')!) ?? []);
      case 'dining-likes':
        return Response.json([]);
      case 'users': {
        const user = users.get(Number(query.get('id')));
        return user ? Response.json(user) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      case 'dining-menu': {
        const found = [...upstream.dinings.values()].flat().find((dining) => dining.id === Number(query.get('id')));
        return found ? Response.json(found) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      case 'dining-range':
        return Response.json(
          [...upstream.dinings.entries()]
            .filter(([date]) => date >= query.get('from')! && date <= query.get('to')!)
            .flatMap(([, rows]) => rows),
        );
      case 'dining-search': {
        const rows = [...upstream.dinings.values()]
          .flat()
          .filter((dining) => dining.menu.includes(query.get('keyword')!));
        return Response.json({ page: Number(query.get('page')), total: rows.length, rows });
      }
      case 'coop-opens':
        return Response.json(upstream.opens);
      case 'dining-notification-targets':
        return Response.json(upstream.targets);
      case 'user-names':
        return Number(query.get('id')) === 7
          ? Response.json({ id: 7, name: ' ', nickname: '코인' })
          : Response.json({ error: 'not_found' }, { status: 404 });
      case 'dining-owned':
      case 'dining-reports':
      case 'dining-report-changes': {
        const pages = upstream.import?.[resource] ?? [];
        const after = Number(query.get('after'));
        const cursor = (item: Record<string, unknown>) =>
          Number(resource === 'dining-report-changes' ? item.sequence : item.id);
        return Response.json(pages.find((page) => cursor(page[0] as Record<string, unknown>) > after) ?? []);
      }
      case 'dining-report-sequence':
        return Response.json({ last_sequence: upstream.sequence ?? 0 });
    }
    throw new Error(`Unexpected upstream ${request.method} ${url.href}`);
  });
}

async function privateKey(): Promise<string> {
  const pair = <CryptoKeyPair>(
    await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
  );
  const bytes = new Uint8Array(<ArrayBuffer>await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
}
const fcmKey = privateKey();

/** cron 한 번 뒤의 상태 + (기본) MySQL 상태 가져오기 완료. */
async function world(
  t: TestContext,
  options: { owner?: boolean; imported?: boolean; upstream?: Partial<Upstream> } = {},
) {
  clearUserStatusCache();
  clearCoopOpensCache();
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { kv, store: kvStore } = memoryKv();
  const objects = memoryDining(kv);
  const upstream: Upstream = {
    dinings: new Map([[DATE, [row(1, 'A코너'), row(2, 'B코너'), row(3, 'A코너', 'DINNER')]]]),
    images: new Set([IMAGE]),
    opens,
    targets: [
      { user_id: 100, device_token: 'token-a' },
      { user_id: 101, device_token: 'token-b' },
    ],
    fcm: [],
    bridge: [],
    ...options.upstream,
  };
  mockFetch(t, upstream);
  const env = diningEnv({
    DINING: objects.namespace,
    BATCH_KV: kv,
    KOIN_DINING_COOP_OWNER: options.owner === false ? 'false' : 'true',
    DINING_REPORT_BOT_TOKEN: BOT_TOKEN,
    FCM_PROJECT_ID: 'koin-test',
    FCM_CLIENT_EMAIL: 'fcm@koin-test.iam.gserviceaccount.com',
    FCM_PRIVATE_KEY: await fcmKey,
  });
  objects.bind(env);
  const call = (path: string, init: RequestInit = {}) =>
    gateway.request(`https://koin-api.workers.dev${path}`, init, env);
  if (options.imported !== false) {
    const response = await call('/internal/workers/dining-coop/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.KOIN_DB_BRIDGE_TOKEN}` },
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  await syncDiningCache(env, new Date(NOW));
  return { env, objects, upstream, call, kv: kvStore };
}

const auth = async (id: number) => ({ Authorization: `Bearer ${await signToken({ id, exp })}` });
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const bot = (body?: unknown) => ({
  method: 'POST',
  headers: { 'X-Koin-Service-Token': BOT_TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const actor = { workspace_id: 'T1', user_id: 'U1', display_name: '홍길동' };

async function failure(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    code: body.code,
    message: body.message,
    ...(body.fieldErrors ? { fieldErrors: body.fieldErrors } : {}),
  };
}

type Call = (path: string, init?: RequestInit) => Response | Promise<Response>;

async function dinings(call: Call, headers: Record<string, string> = {}) {
  const response = await call('/dinings?date=261115', { headers });
  return (await response.json()) as Record<string, unknown>[];
}

async function report(call: Call, student: number, dining = 1) {
  return call(`/dinings/${dining}/soldout-reports`, {
    method: 'POST',
    ...json({ image_url: IMAGE }, await auth(student)),
  });
}

test('helpers match Java encoding, KST timestamps and opening hours', () => {
  assert.equal(
    encodeImagePath(`${PREFIX}upload/COOP/a b+c%d?e#f[g]품.jpg`),
    `${PREFIX}upload/COOP/a%20b%2Bc%25d%3Fe%23f%5Bg%5D%ED%92%88.jpg`,
  );
  assert.equal(kstOffsetTime(Date.parse('2026-11-15T03:00:00.000Z')), '2026-11-15T12:00:00+09:00');
  assert.equal(kstOffsetTime(Date.parse('2026-11-15T03:00:00.120Z')), '2026-11-15T12:00:00.12+09:00');
  assert.equal(kstWallToMs('2026-11-15 12:00:00.123456'), Date.parse('2026-11-15T03:00:00.123Z'));
  const kst = NOW + 9 * 3_600_000;
  assert.equal(openedAt(opens.opens, kst, 'LUNCH', false), true);
  assert.equal(openedAt(opens.opens, kst, 'DINNER', false), false);
  // 요일 개별 시간표가 있으면 주말 설정을 쓰지 않는다. 사진(isMinus)은 1시간 일찍 연다.
  assert.equal(
    openedAt(
      [...opens.opens, { day_of_week: 'SUNDAY', type: '아침', open_time: '08:00', close_time: '09:00' }],
      kst,
      'LUNCH',
      false,
    ),
    false,
  );
  assert.equal(openedAt(opens.opens, Date.parse('2026-11-15T10:00:00Z'), 'LUNCH', true), true);
  assert.equal(
    openedAt([{ day_of_week: 'WEEKEND', type: '점심', open_time: '24:00', close_time: '14:00' }], kst, 'LUNCH', false),
    false,
  );
  const message = diningPushMessage('token', {
    id: 1,
    kind: 'soldout',
    payload: { dining_id: 5, place: 'A코너', type: 'LUNCH' },
    created_at: 0,
    attempts: 0,
    next_attempt_at: 0,
    targets: null,
    cursor: 0,
  });
  assert.deepEqual(message, {
    token: 'token',
    android: {
      priority: 'HIGH',
      data: {
        title: 'A코너가 품절됐어요 😢',
        content: '다른 코너 메뉴도 확인해보세요',
        imageUrl: '',
        url: 'koin://dining?id=5',
        type: 'message',
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title: 'A코너가 품절됐어요 😢', body: '다른 코너 메뉴도 확인해보세요' },
          sound: 'default',
          category: 'dining',
          'mutable-content': 1,
        },
        type: 'message',
        schemeUri: 'dining?id=5',
      },
    },
  });
  const job: OutboxJob = {
    id: 1,
    kind: 'soldout',
    payload: { dining_id: 1, place: '', type: 'LUNCH' },
    created_at: 0,
    attempts: 0,
    next_attempt_at: 0,
    targets: null,
    cursor: 0,
  };
  const particle = (place: string) =>
    diningPushMessage('t', { ...job, payload: { ...job.payload, place } }).android.data.title;
  assert.equal(particle('능수관'), '능수관이 품절됐어요 😢');
  assert.equal(particle('2캠퍼스'), '2캠퍼스가 품절됐어요 😢');
});

function value<T>(outcome: Outcome<T>): T {
  assert.ok('value' in outcome, JSON.stringify(outcome));
  return outcome.value;
}
function code(outcome: Outcome<unknown>): string {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  return outcome.error.code;
}

test('store: report state machine follows DiningReportService order, batches and idempotency', () => {
  const store = memoryCoopStore();
  const dining: DiningMeta = { id: 1, date: DATE, type: 'LUNCH', place: 'A코너' };
  const other: DiningMeta = { id: 2, date: DATE, type: 'LUNCH', place: 'B코너' };
  assert.deepEqual(store.createReport(dining, 7, IMAGE, NOW), {
    error: { status: 503, code: 'KOIN_DB_UNAVAILABLE', message: '학식 저장소가 준비되지 않았습니다.' },
  });
  store.importBegin(false);
  store.importFinish(10);
  assert.deepEqual(value(store.createReport(dining, 7, IMAGE, NOW)), {
    report_id: 1,
    status: 'PENDING',
    created_at: '2026-11-15 12:00:00',
  });
  assert.equal(code(store.createReport(dining, 7, IMAGE, NOW)), 'DINING_REPORT_ALREADY_SUBMITTED');
  assert.equal(
    code(store.createReport({ ...dining, id: 9, date: '2026-11-14' }, 7, IMAGE, NOW)),
    'DINING_REPORT_DATE_NOT_ALLOWED',
  );
  store.createReport(dining, 8, IMAGE, NOW + 1000);
  store.createReport(dining, 9, IMAGE, NOW + 2000);
  store.createReport(other, 7, IMAGE, NOW);

  // 반려는 대상만, 같은 결과 재호출은 최초 묶음을 돌려준다.
  const rejected = value(store.decide(3, actor, 'REJECTED', NOW + 5000, null));
  assert.deepEqual(
    [rejected.report.status, rejected.affected_report_ids, rejected.already_processed],
    ['REJECTED', [3], false],
  );
  assert.equal(code(store.decide(3, actor, 'APPROVED', NOW, true)), 'DINING_REPORT_ALREADY_PROCESSED');

  // 승인은 같은 식단의 PENDING 전부(자동 승인은 source_report_id), 식단 품절(REPORT), 오늘·운영 중이면 알림 예약.
  const approved = value(store.decide(2, actor, 'APPROVED', NOW + 6000, true));
  assert.deepEqual(approved.affected_report_ids, [1, 2]);
  assert.equal(approved.report.processing_type, 'MANUAL');
  assert.deepEqual(approved.report.processor, { workspace_id: 'T1', user_id: 'U1', display_name: '홍길동' });
  assert.equal(approved.report.image_url, encodeImagePath(IMAGE));
  const again = value(store.decide(1, actor, 'APPROVED', NOW + 9000, true));
  assert.deepEqual([again.affected_report_ids, again.already_processed], [[1, 2], true]);
  assert.deepEqual(
    [again.report.processing_type, again.report.source_report_id, again.report.reason],
    ['SAME_DINING_APPROVED', 2, '동일 코스 제보 승인에 따른 자동 처리'],
  );
  assert.deepEqual(
    store.ownedFor(DATE)!.map((entry) => [entry.id, entry.sold_out]),
    [[1, '2026-11-15 12:00:06']],
  );
  assert.equal(store.outboxHead()?.kind, 'soldout');
  assert.equal(code(store.createReport(dining, 10, IMAGE, NOW)), 'DINING_ALREADY_SOLD_OUT');

  // 영양사 품절: 대기 제보는 COOP_PREPROCESSED로 자동 반려, 이미 품절이면 시각·알림을 바꾸지 않는다.
  assert.deepEqual(store.changeSoldOut(other, true, NOW + 10_000, false), { value: undefined });
  const preprocessed = value(store.decide(4, actor, 'REJECTED', NOW, null));
  assert.deepEqual(
    [preprocessed.report.processing_type, preprocessed.already_processed, preprocessed.report.processor],
    ['COOP_PREPROCESSED', true, null],
  );
  const before = store.ownedFor(DATE)!;
  store.changeSoldOut(other, true, NOW + 20_000, true);
  assert.deepEqual(store.ownedFor(DATE), before);
  store.changeSoldOut(other, false, NOW + 30_000, null);
  assert.equal(store.ownedFor(DATE)!.find((entry) => entry.id === 2)?.sold_out, null);
  assert.equal(code(store.decide(99, actor, 'APPROVED', NOW, null)), 'NOT_FOUND_DINING_REPORT');
});

test('store: Java exceptions from opening-hours lookup roll the whole transaction back only when evaluated', () => {
  const store = memoryCoopStore();
  store.importBegin(false);
  store.importFinish(0);
  const dining: DiningMeta = { id: 1, date: DATE, type: 'LUNCH', place: 'A코너' };
  store.createReport(dining, 7, IMAGE, NOW);
  const missing = { status: 404, code: '', message: '해당 학기가 존재하지 않습니다. ' };
  assert.deepEqual(store.decide(1, actor, 'APPROVED', NOW, missing), { error: missing });
  assert.equal(value(store.adminReport(1)).report.status, 'PENDING');
  assert.equal(store.ownedFor(DATE)!.length, 0);
  // 반려·다른 날짜 식단은 운영 시간을 보지 않는다.
  value(store.decide(1, actor, 'REJECTED', NOW, missing));
  value(store.changeSoldOut({ ...dining, id: 2, date: '2026-11-16' }, true, NOW, null));
});

test('store: delivery claim keeps per-report order, 60s lease, 5s retry and replay semantics', () => {
  const store = memoryCoopStore();
  store.importBegin(false);
  store.importFinish(41);
  const dining: DiningMeta = { id: 1, date: DATE, type: 'LUNCH', place: 'A코너' };
  store.createReport(dining, 7, IMAGE, NOW);
  store.decide(1, actor, 'REJECTED', NOW + 1000, null);
  const first = value(store.claim(NOW + 2000))!;
  assert.equal(first.report.status, 'PENDING');
  assert.equal(first.report.image_url, encodeImagePath(IMAGE));
  assert.equal(first.expires_at, '2026-11-15T12:01:02+09:00');
  // 앞선 변경(CREATED)이 끝나기 전에는 PROCESSED를 배정하지 않는다.
  assert.equal(value(store.claim(NOW + 3000)), null);
  const reassigned = value(store.claim(NOW + 62_000))!;
  assert.equal(reassigned.delivery_id, first.delivery_id);
  assert.notEqual(reassigned.attempt_token, first.attempt_token);
  assert.equal(
    code(store.recordResult(first.delivery_id, first.attempt_token, 'SUCCEEDED', NOW)),
    'DINING_REPORT_DELIVERY_CONFLICT',
  );
  const queued = { delivery_id: first.delivery_id, delivery_state: 'QUEUED' };
  assert.deepEqual(
    value(store.recordResult(first.delivery_id, reassigned.attempt_token, 'FAILED', NOW + 63_000)),
    queued,
  );
  assert.deepEqual(value(store.recordResult(first.delivery_id, reassigned.attempt_token, 'FAILED', NOW)), queued);
  assert.equal(
    code(store.recordResult(first.delivery_id, reassigned.attempt_token, 'SUCCEEDED', NOW)),
    'DINING_REPORT_DELIVERY_CONFLICT',
  );
  assert.equal(value(store.claim(NOW + 67_000)), null);
  const retry = value(store.claim(NOW + 68_000))!;
  assert.equal(retry.delivery_id, first.delivery_id);
  store.recordResult(retry.delivery_id, retry.attempt_token, 'SUCCEEDED', NOW + 68_500);
  const processed = value(store.claim(NOW + 69_000))!;
  assert.equal(processed.report.status, 'REJECTED');
  // 다른 작업의 토큰은 404.
  assert.equal(
    code(store.recordResult(processed.delivery_id, retry.attempt_token, 'SUCCEEDED', NOW)),
    'NOT_FOUND_DINING_REPORT_DELIVERY',
  );
  assert.equal(
    code(store.recordResult(crypto.randomUUID(), retry.attempt_token, 'SUCCEEDED', NOW)),
    'NOT_FOUND_DINING_REPORT_DELIVERY',
  );
});

test('store: one-shot import, force re-import and versions that keep increasing', () => {
  const store = memoryCoopStore();
  store.importBegin(false);
  store.importDinings([
    {
      id: 1,
      date: DATE,
      type: 'LUNCH',
      place: 'A코너',
      sold_out: '2026-11-15 11:00:00',
      sold_out_source: 'COOP',
      image_url: IMAGE,
    },
  ]);
  assert.deepEqual(value(store.importFinish(3)), { dinings: 1, reports: 0, changes: 0, last_sequence: 3 });
  assert.equal(code(store.importBegin(false)), 'DINING_COOP_ALREADY_IMPORTED');
  const version = store.ownedFor(DATE)![0]!.version;
  store.importBegin(true);
  store.importDinings([
    { id: 1, date: DATE, type: 'LUNCH', place: 'A코너', sold_out: null, sold_out_source: null, image_url: null },
  ]);
  store.importFinish(3);
  assert.ok(store.ownedFor(DATE)![0]!.version > version);
});

test('HTTP: flag off forwards coop paths to Java; before import writes are 503', async (t) => {
  const off = await world(t, { owner: false, imported: false });
  const forwarded = await off.call('/coop/dining/soldout', {
    method: 'PATCH',
    ...json({ menu_id: 1, sold_out: true }, await auth(9)),
  });
  // Java로 보낸다(테스트 원본은 응답하지 않으므로 502).
  assert.deepEqual([forwarded.status, forwarded.headers.get('X-Koin-Backend')], [502, 'aws']);
  t.mock.restoreAll();
  t.mock.timers.reset();
  const pending = await world(t, { imported: false });
  const response = await pending.call('/coop/dining/soldout', {
    method: 'PATCH',
    ...json({ menu_id: 1, sold_out: true }, await auth(9)),
  });
  assert.deepEqual(await failure(response), {
    status: 503,
    code: 'KOIN_DB_UNAVAILABLE',
    message: '학식 저장소가 준비되지 않았습니다.',
  });
});

test('HTTP: coop soldout auth, Spring/Jackson validation and Java error messages', async (t) => {
  const { call } = await world(t);
  const patch = async (body: unknown, user: number | null = 9, headers: Record<string, string> = {}) =>
    call('/coop/dining/soldout', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(user === null ? {} : await auth(user)), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  assert.equal((await failure(await patch({ menu_id: 1, sold_out: true }, null))).code, 'UNAUTHORIZED_USER');
  assert.equal((await failure(await patch({ menu_id: 1, sold_out: true }, 7))).code, 'FORBIDDEN_USER_TYPE');
  assert.deepEqual(await failure(await patch({})), {
    status: 400,
    code: 'INVALID_REQUEST_BODY',
    message: '메뉴 ID는 필수입니다.',
    fieldErrors: [
      { field: 'menu_id', message: '메뉴 ID는 필수입니다.', constraint: 'NotNull' },
      { field: 'sold_out', message: '품절 여부는 필수입니다.', constraint: 'NotNull' },
    ],
  });
  assert.equal((await failure(await patch({ menu_id: 'x', sold_out: true }))).code, 'NOT_READABLE_HTTP_MESSAGE');
  assert.equal((await failure(await patch('{'))).code, 'NOT_READABLE_HTTP_MESSAGE');
  assert.equal((await failure(await patch([1]))).code, 'NOT_READABLE_HTTP_MESSAGE');
  const plain = await call('/coop/dining/soldout', {
    method: 'PATCH',
    headers: { ...(await auth(9)), 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.deepEqual(await failure(plain), {
    status: 415,
    code: '',
    message: "Content-Type 'text/plain' is not supported",
  });
  assert.deepEqual(await failure(await patch({ menu_id: 404, sold_out: true })), {
    status: 404,
    code: '',
    message: '존재하지 않는 메뉴입니다. menuId: 404',
  });
  // Jackson 강제 변환: "1"·1.9 → 1, "true" → true.
  assert.equal((await patch({ menu_id: '1', sold_out: 'true' })).status, 200);
  assert.equal((await patch({ menu_id: 1.9, sold_out: 1 })).status, 200);
});

test('HTTP: coop soldout updates GET /dinings (Bearer, KV, service token), rejects pending reports and throttles FCM per place', async (t) => {
  const { call, objects, upstream, kv } = await world(t);
  assert.equal((await report(call, 7)).status, 201);
  const soldout = await call('/coop/dining/soldout', {
    method: 'PATCH',
    ...json({ menu_id: 1, sold_out: true }, await auth(9)),
  });
  assert.equal(soldout.status, 200);
  assert.equal(soldout.headers.get('X-Koin-Backend'), 'workers');
  const variants: Record<string, string>[] = [await auth(7), {}, { 'X-Koin-Service-Token': BOT_TOKEN }];
  for (const headers of variants) {
    const [first] = await dinings(call, headers);
    assert.deepEqual([first!.soldout_at, first!.updated_at], ['2026-11-15 12:00:00', '2026-11-15 03:00:00']);
  }
  await objects.flush();
  assert.equal(JSON.parse(kv.get(`koin:dining:v1:${DATE}`)!)[0].sold_out, '2026-11-15 12:00:00');
  // 대기 제보는 영양사 선처리로 반려된다.
  const detail = await call('/internal/dining/soldout-reports/1', { headers: { 'X-Koin-Service-Token': BOT_TOKEN } });
  assert.deepEqual(((await detail.json()) as Record<string, unknown>).processing_type, 'COOP_PREPROCESSED');

  // outbox: 운영 중·오늘·장소 제한 없음 → 구독자 전원에게 전송 후 A코너 2시간 제한.
  assert.ok(objects.alarms.length > 0);
  await objects.coopAlarm();
  assert.deepEqual(
    upstream.fcm.map((message) => message.token),
    ['token-a', 'token-b'],
  );
  assert.ok(upstream.bridge.includes('dining-notification-targets?type=DINING_SOLD_OUT&detail=LUNCH'));
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 1, sold_out: false }, await auth(9)) });
  assert.equal((await dinings(call, await auth(7)))[0]!.soldout_at, null);
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 1, sold_out: true }, await auth(9)) });
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 3, sold_out: true }, await auth(9)) });
  await objects.coopAlarm();
  assert.equal(upstream.fcm.length, 2, 'same place within 2h and closed dinner are not notified');
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 2, sold_out: true }, await auth(9)) });
  await objects.coopAlarm();
  assert.deepEqual(
    upstream.fcm.slice(2).map((message) => message.android.data.title),
    ['B코너가 품절됐어요 😢', 'B코너가 품절됐어요 😢'],
  );
});

test('HTTP: coop image save notifies once per date/meal with the old (null) image and drives image_url/updated_at', async (t) => {
  // 사진 판정은 JVM(Asia/Seoul) 시계다: UTC 01:30 = KST 10:30 = 점심 11:00-1h 이후. updated_at은 UTC로 나간다.
  const { call, objects, upstream } = await world(t);
  t.mock.timers.setTime(Date.parse('2026-11-15T01:30:00Z'));
  const save = (id: number, url: string) =>
    auth(9).then((headers) =>
      call('/coop/dining/image', { method: 'PATCH', ...json({ menu_id: id, image_url: url }, headers) }),
    );
  assert.deepEqual(await failure(await save(1, '')), {
    status: 400,
    code: 'INVALID_REQUEST_BODY',
    message: '메뉴 이미지는 필수입니다.',
    fieldErrors: [{ field: 'image_url', message: '메뉴 이미지는 필수입니다.', constraint: 'NotEmpty' }],
  });
  assert.equal((await save(1, `${PREFIX}menu/a.jpg`)).status, 200);
  assert.equal((await save(2, `${PREFIX}menu/b.jpg`)).status, 200);
  const rows = await dinings(call, await auth(7));
  assert.deepEqual(
    rows.map((dining) => [dining.id, dining.image_url, dining.updated_at]),
    [
      [1, `${PREFIX}menu/a.jpg`, '2026-11-15 01:30:00'],
      [2, `${PREFIX}menu/b.jpg`, '2026-11-15 01:30:00'],
      [3, null, '2026-11-14 01:00:00'],
    ],
  );
  await objects.coopAlarm();
  assert.equal(upstream.fcm.length, 2);
  const [message] = upstream.fcm;
  assert.ok(message);
  assert.equal(message.android.data.title, '식단 사진이 업로드 됐어요!');
  assert.equal(message.android.data.imageUrl, '');
  assert.equal('fcm_options' in message.apns, false);
  assert.ok(upstream.bridge.includes('dining-notification-targets?type=DINING_IMAGE_UPLOAD'));
  // 학기 정보가 없으면 Java처럼 404로 실패하고 값은 바뀌지 않는다.
  upstream.opens = { semester_id: null, coop_name_id: null, shop_id: null, opens: [] };
  clearCoopOpensCache();
  assert.deepEqual(await failure(await save(3, `${PREFIX}menu/c.jpg`)), {
    status: 404,
    code: '',
    message: '해당 학기가 존재하지 않습니다. ',
  });
  assert.equal((await dinings(call, await auth(7)))[2]!.image_url, null);
});

test('HTTP: student reports validate the image like S3 and follow Java error order', async (t) => {
  const { call, upstream } = await world(t);
  const post = async (path: string, body: unknown, user = 7) =>
    call(path, { method: 'POST', ...json(body, await auth(user)) });
  assert.equal(
    (await failure(await post('/dinings/1/soldout-reports', { image_url: IMAGE }, 9))).code,
    'FORBIDDEN_USER_TYPE',
  );
  assert.equal(
    (await failure(await post('/dinings/x/soldout-reports', { image_url: IMAGE }))).code,
    'ILLEGAL_ARGUMENT',
  );
  assert.deepEqual(await failure(await post('/dinings/1/soldout-reports', { image_url: '  ' })), {
    status: 400,
    code: 'INVALID_REQUEST_BODY',
    message: '제보 사진 URL은 필수입니다.',
    fieldErrors: [{ field: 'image_url', message: '제보 사진 URL은 필수입니다.', constraint: 'NotBlank' }],
  });
  for (const image of [
    'https://static.example.com/upload/COOP/a.jpg',
    `${PREFIX}upload/OWNER/a.jpg`,
    `${PREFIX}upload/COOP/`,
    `${PREFIX}upload/COOP/a.jpg?x=1`,
    `${PREFIX}upload/COOP/a|b.jpg`,
    `${PREFIX}upload/COOP/missing.jpg`,
  ]) {
    assert.equal(
      (await failure(await post('/dinings/1/soldout-reports', { image_url: image }))).code,
      'INVALID_REPORT_IMAGE',
      image,
    );
  }
  // 사진 검증이 식단 확인보다 먼저다.
  assert.equal(
    (await failure(await post('/dinings/404/soldout-reports', { image_url: `${PREFIX}upload/COOP/missing.jpg` }))).code,
    'INVALID_REPORT_IMAGE',
  );
  assert.equal(
    (await failure(await post('/dinings/404/soldout-reports', { image_url: IMAGE }))).code,
    'NOT_FOUND_DINING',
  );
  const created = await post('/dinings/0x1/soldout-reports', { image_url: IMAGE });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { report_id: 1, status: 'PENDING', created_at: '2026-11-15 12:00:00' });
  assert.deepEqual(await failure(await post('/dinings/1/soldout-reports', { image_url: IMAGE })), {
    status: 409,
    code: 'DINING_REPORT_ALREADY_SUBMITTED',
    message: '이미 제보한 식단입니다.',
  });
  upstream.dinings.set('2026-11-14', [{ ...row(50, 'A코너'), date: '2026-11-14' }]);
  assert.equal(
    (await failure(await post('/dinings/50/soldout-reports', { image_url: IMAGE }))).code,
    'DINING_REPORT_DATE_NOT_ALLOWED',
  );
});

test('HTTP: bot endpoints authenticate first and run the delivery protocol', async (t) => {
  const { call } = await world(t);
  const unauthorized = await call('/internal/dining/soldout-reports/unknown/path', { method: 'DELETE' });
  assert.deepEqual(await failure(unauthorized), {
    status: 401,
    code: 'BOT_AUTHENTICATION_FAILED',
    message: '삐봇 서비스 인증에 실패했습니다.',
  });
  const empty = await call('/internal/dining/soldout-reports/deliveries/claim', bot());
  assert.deepEqual([empty.status, empty.headers.get('Retry-After'), await empty.text()], [204, '5', '']);
  await report(call, 7);
  await report(call, 8);
  const claim = (await (await call('/internal/dining/soldout-reports/deliveries/claim', bot())).json()) as {
    delivery_id: string;
    attempt_token: string;
    report: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(claim), ['delivery_id', 'attempt_token', 'expires_at', 'report']);
  assert.equal(claim.report.report_id, 1);
  const result = (body: unknown, id = claim.delivery_id) =>
    call(`/internal/dining/soldout-reports/deliveries/${id}/result`, bot(body));
  assert.equal(
    (await failure(await result({ attempt_token: claim.attempt_token, outcome: 'SUCCEEDED', extra: 1 }))).code,
    'INVALID_REQUEST_BODY',
  );
  assert.equal(
    (await failure(await result({ attempt_token: 'nope', outcome: null }))).code,
    'NOT_READABLE_HTTP_MESSAGE',
  );
  assert.equal(
    (await failure(await result({ attempt_token: claim.attempt_token, outcome: 'DONE' }))).code,
    'NOT_READABLE_HTTP_MESSAGE',
  );
  assert.equal(
    (await failure(await result({ attempt_token: claim.attempt_token, outcome: 'SUCCEEDED' }, 'not-uuid'))).code,
    'ILLEGAL_ARGUMENT',
  );
  const done = await result(
    { attempt_token: claim.attempt_token.toUpperCase(), outcome: 'SUCCEEDED' },
    claim.delivery_id.toUpperCase(),
  );
  assert.deepEqual(await done.json(), { delivery_id: claim.delivery_id, delivery_state: 'DELIVERED' });

  const approve = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    call(`/internal/dining/soldout-reports/${id}/approve`, {
      ...bot(body),
      headers: { ...bot(body).headers, ...headers },
    });
  assert.deepEqual(await failure(await approve('2', {})), {
    status: 400,
    code: 'INVALID_REQUEST_BODY',
    message: '처리자 정보는 필수입니다.',
    fieldErrors: [{ field: 'actor', message: '처리자 정보는 필수입니다.', constraint: 'NotNull' }],
  });
  assert.deepEqual(
    (await failure(await approve('2', { actor: { ...actor, user_id: ' ' } }, { 'Accept-Language': 'ko-KR' })))
      .fieldErrors,
    [{ field: 'actor.user_id', message: '공백일 수 없습니다', constraint: 'NotBlank' }],
  );
  assert.equal((await failure(await approve('x', { actor }))).code, 'ILLEGAL_ARGUMENT');
  const approved = (await (await approve('2', { actor })).json()) as Record<string, unknown>;
  assert.deepEqual([approved.affected_report_ids, approved.already_processed], [[1, 2], false]);
  const rejected = await call('/internal/dining/soldout-reports/1/reject', bot({ actor }));
  assert.equal((await failure(rejected)).code, 'DINING_REPORT_ALREADY_PROCESSED');
  // 품절 반영: 제보 승인 식단도 GET /dinings에 보인다.
  assert.equal((await dinings(call))[0]!.soldout_at, '2026-11-15 12:00:00');
});

test('HTTP: admin report list/detail use ADMIN auth, Criteria paging and reporter fallback names', async (t) => {
  const { call } = await world(t);
  await report(call, 7);
  t.mock.timers.setTime(NOW + 60_000);
  await report(call, 8);
  assert.equal(
    (await failure(await call('/admin/dining/soldout-reports', { headers: await auth(9) }))).code,
    'FORBIDDEN_USER_TYPE',
  );
  assert.equal(
    (await failure(await call('/admin/dining/soldout-reports', { headers: await auth(22) }))).code,
    'FORBIDDEN_ADMIN',
  );
  const list = (await (
    await call('/admin/dining/soldout-reports?limit=1&page=9', { headers: await auth(21) })
  ).json()) as Record<string, unknown>;
  assert.deepEqual([list.total_count, list.current_count, list.total_page, list.current_page], [2, 1, 2, 2]);
  assert.deepEqual(Object.keys((list.reports as Record<string, unknown>[])[0]!), [
    'report_id',
    'dining',
    'status',
    'processing_type',
    'reason',
    'created_at',
    'processed_at',
    'processor',
  ]);
  assert.equal((list.reports as Record<string, unknown>[])[0]!.report_id, 1);
  assert.equal(
    (await failure(await call('/admin/dining/soldout-reports?only_pending=maybe', { headers: await auth(21) }))).code,
    'ILLEGAL_ARGUMENT',
  );
  const detail = (await (await call('/admin/dining/soldout-reports/1', { headers: await auth(21) })).json()) as Record<
    string,
    unknown
  >;
  assert.equal(detail.image_url, IMAGE);
  assert.deepEqual(detail.reporter, { id: 7, name: '코인' });
  const other = (await (await call('/admin/dining/soldout-reports/2', { headers: await auth(21) })).json()) as Record<
    string,
    unknown
  >;
  assert.equal(other.reporter, null);
});

test('HTTP: search, excel and image archive read MySQL rows with DO-owned image, soldout and likes', async (t) => {
  const { call, upstream } = await world(t);
  await call('/dining/like?diningId=1', { method: 'PATCH', headers: await auth(7) });
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 2, sold_out: true }, await auth(9)) });
  const search = await call('/dinings/search?keyword=%EB%B0%A5&filter=A%EC%BD%94%EB%84%88,B%EC%BD%94%EB%84%88', {
    headers: await auth(9),
  });
  const body = (await search.json()) as { total_page: number; dinings: Record<string, unknown>[] };
  assert.equal(body.total_page, 1);
  assert.deepEqual(
    body.dinings.map((dining) => [dining.id, dining.likes, dining.soldout_at, dining.kcal]),
    [
      [1, 1, '2026-11-14 01:00:00', 700],
      [2, 0, '2026-11-14 01:00:00', 700],
      [3, 0, '2026-11-14 01:00:00', 700],
    ],
  );
  assert.ok(
    upstream.bridge.some(
      (entry) =>
        entry.startsWith('dining-search?') && entry.includes('places=A%EC%BD%94%EB%84%88%2CB%EC%BD%94%EB%84%88'),
    ),
  );
  assert.equal(
    (await failure(await call('/dinings/search?keyword=a&filter=2캠퍼스', { headers: await auth(9) }))).code,
    'ILLEGAL_ARGUMENT',
  );
  assert.deepEqual(await failure(await call('/dinings/search', { headers: await auth(9) })), {
    status: 400,
    code: '',
    message: "Required request parameter 'keyword' for method parameter type String is not present",
  });

  const excel = await call('/coop/dining/excel?startDate=2026-11-15&endDate=2026-11-15&isCafeteria=true', {
    headers: await auth(9),
  });
  assert.equal(excel.status, 200);
  assert.equal(excel.headers.get('Content-Disposition'), 'attachment; filename=2026-11-15 ~ 2026-11-15 menu.xlsx');
  const sheet = strFromU8(unzipSync(new Uint8Array(await excel.arrayBuffer()))['xl/worksheets/sheet1.xml']!);
  assert.ok(sheet.includes('품절 (2026-11-15T12:00)'));
  const duplicate = await call('/coop/dining/excel?startDate=2026-11-15&endDate=2026-11-15', {
    headers: await auth(9),
  });
  assert.deepEqual(await failure(duplicate), {
    status: 409,
    code: '',
    message: "동일한 요청을 30초 안에 다시 보낼 수 없습니다! startDate: '2026-11-15'endDate: 2026-11-15",
  });
  assert.deepEqual(
    await failure(await call('/coop/dining/excel?startDate=2026-11-16&endDate=2026-11-16', { headers: await auth(9) })),
    {
      status: 400,
      code: '',
      message: '오늘 날짜 이후 기간은 설정할 수 없어요. null',
    },
  );

  // URLDecoder.decode는 '+'를 공백으로 바꾸므로(Java와 같이) 압축 대상은 '+' 없는 키로 확인한다.
  const photo = `${PREFIX}upload/COOP/2026/11/15/uuid/menu photo.jpg`;
  upstream.images.add(photo);
  await call('/coop/dining/image', { method: 'PATCH', ...json({ menu_id: 1, image_url: photo }, await auth(9)) });
  const archive = await call('/coop/dining/image?startDate=2026-11-15&endDate=2026-11-15', { headers: await auth(9) });
  assert.equal(archive.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''dining_images.zip");
  assert.equal(archive.headers.get('Cache-Control'), 'public, max-age=3600');
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ['dining_images/', 'dining_images/2026-11-15-점심-A코너.jpg']);
  assert.equal(
    strFromU8(files['dining_images/2026-11-15-점심-A코너.jpg']!),
    'bytes:/upload/COOP/2026/11/15/uuid/menu%20photo.jpg',
  );
});

test('HTTP: import pages MySQL owned dinings, reports and changes; cron then shows DO values', async (t) => {
  const processing = '550e8400-e29b-41d4-a716-446655440000';
  const snapshot = JSON.stringify({ report_id: 5, image_url: IMAGE, status: 'PENDING' });
  const { call } = await world(t, {
    upstream: {
      import: {
        'dining-owned': [
          [
            {
              id: 2,
              date: DATE,
              type: 'LUNCH',
              place: 'B코너',
              sold_out: '2026-11-15 11:50:00',
              sold_out_source: 'COOP',
              image_url: IMAGE,
            },
          ],
        ],
        'dining-reports': [
          [
            {
              id: 5,
              dining_id: 1,
              reporter_id: 7,
              image_url: IMAGE,
              status: 'APPROVED',
              processing_type: 'MANUAL',
              processing_id: processing,
              source_report_id: null,
              processor_workspace_id: 'T',
              processor_user_id: 'U',
              processor_name: 'N',
              processed_at: '2026-11-15 11:00:00',
              created_at: '2026-11-15 10:00:00',
              updated_at: '2026-11-15 11:00:00',
              dining_date: DATE,
              dining_type: 'LUNCH',
              dining_place: 'A코너',
            },
          ],
        ],
        'dining-report-changes': [
          [
            {
              sequence: 8,
              report_id: 5,
              event_type: 'PROCESSED',
              status: 'APPROVED',
              processing_type: 'MANUAL',
              processing_id: processing,
              occurred_at: '2026-11-15 11:00:00',
              delivery_id: processing,
              report_snapshot: snapshot,
              delivery_state: 'IN_PROGRESS',
              attempt_token: '11111111-1111-4111-8111-111111111111',
              expires_at: '2026-11-15 11:59:00.500000',
              next_attempt_at: null,
              accepted_outcome: null,
            },
          ],
        ],
      },
      sequence: 8,
    },
  });
  // 만료된 Java 배정은 같은 delivery_id로 다시 배정된다.
  const claim = (await (await call('/internal/dining/soldout-reports/deliveries/claim', bot())).json()) as Record<
    string,
    unknown
  >;
  assert.equal(claim.delivery_id, processing);
  // 새 제보는 가져온 최대 ID 다음 번호다.
  assert.equal((await failure(await report(call, 8, 2))).code, 'DINING_ALREADY_SOLD_OUT');
  assert.equal(((await (await report(call, 8, 3)).json()) as { report_id: number }).report_id, 6);
  const rows = await dinings(call, await auth(7));
  assert.deepEqual(
    rows.map((dining) => [dining.id, dining.soldout_at, dining.image_url]),
    [
      [1, null, null],
      [2, '2026-11-15 11:50:00', IMAGE],
      [3, null, null],
    ],
  );
  const again = await call('/internal/workers/dining-coop/import', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-only-bridge-token-with-32-characters' },
  });
  assert.equal((await failure(again)).code, 'DINING_COOP_ALREADY_IMPORTED');
  const wrong = await call('/internal/workers/dining-coop/import', { method: 'POST' });
  assert.equal(wrong.status, 401);
});

test('rollback: flag off restores MySQL values on the next refresh', async (t) => {
  const { env, call } = await world(t);
  await call('/coop/dining/soldout', { method: 'PATCH', ...json({ menu_id: 1, sold_out: true }, await auth(9)) });
  assert.equal((await dinings(call, await auth(7)))[0]!.soldout_at, '2026-11-15 12:00:00');
  const off = { ...env, KOIN_DINING_COOP_OWNER: 'false' } as Bindings;
  await syncDiningCache(off, new Date(NOW));
  const response = await gateway.request(
    'https://koin-api.workers.dev/dinings?date=261115',
    { headers: await auth(7) },
    off,
  );
  assert.equal(((await response.json()) as Record<string, unknown>[])[0]!.soldout_at, null);
});
