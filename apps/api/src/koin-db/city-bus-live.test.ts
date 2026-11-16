import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import gateway from '@api/koin-db/gateway';
import { trackingMode } from './city-bus-live';
import { handleCityBusArrivalHistory, readCityBusRemainTime } from './city-bus-realtime';
import {
  arrivalItem,
  cityBusEnv,
  locationItem,
  memoryCityBus,
  mockTago,
  NOT_REGISTERED,
  ROUTES,
} from './tests/tago-fixture';

// 2026-11-16(월) 08:00 KST.
const NOW = Date.parse('2026-11-15T23:00:00Z');
const MINUTE = 60_000;
const WEEK = 7 * 86_400_000;
const KOREATECH_SOUTH = 'CAB285000405';
const bus = (query: string) => new URL(`https://api.test/bus?${query}`);
// node:sqlite 행은 null 프로토타입이다.
const rows = (db: DatabaseSync, query: string) =>
  db
    .prepare(query)
    .all()
    .map((row) => ({ ...row }));

test('tracking mode defaults to location and accepts arrival/off', () => {
  assert.equal(trackingMode(undefined), 'location');
  assert.equal(trackingMode('arrival'), 'arrival');
  assert.equal(trackingMode('off'), 'off');
  assert.equal(trackingMode('LOCATION'), 'location');
});

test('GET /bus city answers Java-shaped remain times from the arrival API and caches 60s', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('off');
  await live.tick(NOW);
  // 하루 한 번 7개 정류소 경유 노선만 받는다(off 방식은 수집하지 않는다).
  assert.deepEqual(tago.calls, Array(7).fill('getSttnThrghRouteList'));
  await live.tick(NOW + MINUTE);
  assert.equal(tago.calls.length, 7);

  tago.arrivals.set(KOREATECH_SOUTH, [
    arrivalItem(KOREATECH_SOUTH, '400S', 300, 3),
    arrivalItem(KOREATECH_SOUTH, '402S', 120, 1),
    arrivalItem(KOREATECH_SOUTH, '405S', 900, 8),
  ]);
  const env = cityBusEnv(live);
  const first = await readCityBusRemainTime(env, bus('bus_type=city&depart=koreatech&arrival=TERMINAL'), NOW);
  assert.ok(first);
  assert.equal(
    await first.text(),
    '{"bus_type":"city","now_bus":{"bus_number":402,"remain_time":120},"next_bus":{"bus_number":400,"remain_time":300}}',
  );
  const cached = await readCityBusRemainTime(env, bus('bus_type=CITY&depart=KOREATECH&arrival=terminal'), NOW + 30_000);
  assert.deepEqual(await cached?.json(), {
    bus_type: 'city',
    now_bus: { bus_number: 402, remain_time: 90 },
    next_bus: { bus_number: 400, remain_time: 270 },
  });
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 1);
  await readCityBusRemainTime(env, bus('bus_type=city&depart=koreatech&arrival=terminal'), NOW + 61_000);
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 2);
});

test('GET /bus city keeps only numbers serving both stations (Java route intersection)', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('off');
  await live.tick(NOW);
  const terminal = 'CAB285000686';
  tago.arrivals.set(terminal, [
    arrivalItem(terminal, '12N', 60, 1),
    arrivalItem(terminal, '400N', 200, 2),
    { ...arrivalItem(terminal, '402N', 30, 1), routeno: '순환2' },
  ]);
  const env = cityBusEnv(live);
  // 터미널 → 천안역: 12번도 두 정류소를 지난다.
  const station = await readCityBusRemainTime(env, bus('bus_type=city&depart=terminal&arrival=station'), NOW);
  assert.deepEqual(await station?.json(), {
    bus_type: 'city',
    now_bus: { bus_number: 12, remain_time: 60 },
    next_bus: { bus_number: 400, remain_time: 200 },
  });
  // 터미널 → 한기대: 12번은 한기대를 지나지 않는다. 다음 버스가 없으면 null.
  const school = await readCityBusRemainTime(env, bus('bus_type=city&depart=terminal&arrival=koreatech'), NOW);
  assert.equal(
    await school?.text(),
    '{"bus_type":"city","now_bus":{"bus_number":400,"remain_time":200},"next_bus":null}',
  );
});

test('GET /bus city outside service hours answers empty without calling TAGO', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('location');
  const night = NOW - 5 * 3_600_000; // 03:00 KST
  await live.tick(night);
  const routeCalls = tago.calls.length;
  await live.tick(night + MINUTE);
  const response = await readCityBusRemainTime(
    cityBusEnv(live),
    bus('bus_type=city&depart=koreatech&arrival=terminal'),
    night,
  );
  assert.equal(await response?.text(), '{"bus_type":"city","now_bus":null,"next_bus":null}');
  assert.ok(!tago.calls.slice(routeCalls).some((call) => call !== 'getSttnThrghRouteList'));
});

test('GET /bus defers to Java for other bus types, odd params, same stations and TAGO failures', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('off');
  const env = cityBusEnv(live);
  for (const query of [
    'bus_type=shuttle&depart=koreatech&arrival=terminal',
    'bus_type=express&depart=koreatech&arrival=terminal',
    'bus_type=city&depart=koreatech&arrival=koreatech',
    'bus_type=city&depart=학교&arrival=terminal',
    'bus_type=city&bus_type=city&depart=koreatech&arrival=terminal',
    'bus_type=city&depart=koreatech',
  ]) {
    assert.equal(await readCityBusRemainTime(env, bus(query), NOW), null, query);
  }
  assert.equal(tago.calls.length, 0);
  tago.failures.set('getSttnAcctoArvlPrearngeInfoList', new Response(NOT_REGISTERED, { status: 200 }));
  assert.equal(await readCityBusRemainTime(env, bus('bus_type=city&depart=koreatech&arrival=terminal'), NOW), null);
  // 키가 없으면 TAGO를 부르지 않고 Java로 보낸다.
  const { live: keyless } = memoryCityBus('off', undefined);
  assert.equal(
    await readCityBusRemainTime(cityBusEnv(keyless), bus('bus_type=city&depart=koreatech&arrival=terminal'), NOW),
    null,
  );
  // gateway: Java로 프록시(테스트에서는 원본 연결 실패 → 502 aws).
  const proxied = await gateway.request(
    'https://api.test/bus?bus_type=shuttle&depart=koreatech&arrival=terminal',
    {},
    env,
  );
  assert.equal(proxied.headers.get('X-Koin-Backend'), 'aws');
});

test('arrival mode records a vehicle reaching the stop and serves same-weekday history', async (t) => {
  const tago = mockTago(t);
  const { live, db } = memoryCityBus('arrival');
  tago.arrivals.set(KOREATECH_SOUTH, [
    arrivalItem(KOREATECH_SOUTH, '400S', 50, 1),
    arrivalItem(KOREATECH_SOUTH, '12S', 20, 1),
  ]);
  await live.tick(NOW);
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 7);
  // 같은 버스가 아직 오는 중이면 기록하지 않는다.
  tago.arrivals.set(KOREATECH_SOUTH, [arrivalItem(KOREATECH_SOUTH, '400S', 20, 1)]);
  await live.tick(NOW + MINUTE);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM arrivals').get()!.n, 0);
  // 가장 가까운 400번이 더 먼 차량(남은 정류소 증가)으로 바뀌면 직전 예정 시각에 도착한 것으로 본다.
  tago.arrivals.set(KOREATECH_SOUTH, [arrivalItem(KOREATECH_SOUTH, '400S', 1500, 12)]);
  await live.tick(NOW + 2 * MINUTE);
  // 그 사이 캐시가 채워져 실시간 조회는 TAGO를 다시 부르지 않는다.
  const before = tago.calls.length;
  const remain = await readCityBusRemainTime(
    cityBusEnv(live),
    bus('bus_type=city&depart=koreatech&arrival=terminal'),
    NOW + 2 * MINUTE + 10_000,
  );
  assert.deepEqual(await remain?.json(), {
    bus_type: 'city',
    now_bus: { bus_number: 400, remain_time: 1490 },
    next_bus: null,
  });
  assert.equal(tago.calls.length, before);
  assert.deepEqual(rows(db, 'SELECT node_id, route_id, bus_number, arrived_at, estimated, source FROM arrivals'), [
    {
      node_id: KOREATECH_SOUTH,
      route_id: ROUTES['400S'].routeid,
      bus_number: 400,
      arrived_at: NOW + MINUTE + 20_000,
      estimated: 1,
      source: 'arrival',
    },
  ]);

  // 1주 뒤 같은 요일 08:10 조회 → ±30분 창 안의 08:01:20 기록.
  const url = new URL(
    'https://api.test/bus/city/arrival-history?station=KOREATECH&direction=south&bus_number=400&weeks=2',
  );
  const response = await handleCityBusArrivalHistory(cityBusEnv(live), url, NOW + WEEK + 10 * MINUTE);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    bus_number: 400,
    station: 'koreatech',
    direction: 'south',
    weeks: 2,
    base_time: '08:10',
    window_minutes: 30,
    days: [
      { date: '2026-11-16', arrivals: [{ bus_number: 400, arrival_time: '08:01:20', estimated: true }] },
      { date: '2026-11-09', arrivals: [] },
    ],
  });
  // 창 밖(08:40 기준 → 08:10~09:10)이거나 다른 방향이면 없다.
  const outside = await handleCityBusArrivalHistory(cityBusEnv(live), url, NOW + WEEK + 40 * MINUTE);
  assert.deepEqual(await outside.json(), {
    bus_number: 400,
    station: 'koreatech',
    direction: 'south',
    weeks: 2,
    base_time: '08:40',
    window_minutes: 30,
    days: [
      { date: '2026-11-16', arrivals: [] },
      { date: '2026-11-09', arrivals: [] },
    ],
  });
  const north = new URL('https://api.test/bus/city/arrival-history?station=koreatech&direction=north');
  const other = await handleCityBusArrivalHistory(cityBusEnv(live), north, NOW + WEEK);
  assert.deepEqual(await other.json(), {
    bus_number: null,
    station: 'koreatech',
    direction: 'north',
    weeks: 4,
    base_time: '08:00',
    window_minutes: 30,
    days: ['2026-11-16', '2026-11-09', '2026-11-02', '2026-10-26'].map((date) => ({ date, arrivals: [] })),
  });
});

test('location mode records stop arrivals (interpolated between polls) and learns travel times', async (t) => {
  const tago = mockTago(t);
  const { live, db } = memoryCityBus('location');
  const route = ROUTES['400S'].routeid;
  tago.locations.set(route, [locationItem('충남71자1001', 8)]);
  await live.tick(NOW);
  // 경유 노선 7 + 추적 노선 정류소 6 + 위치 6. 도착 API는 부르지 않는다.
  assert.equal(tago.calls.filter((call) => call === 'getRouteAcctoThrghSttnList').length, 6);
  assert.equal(tago.calls.filter((call) => call === 'getRouteAcctoBusLcList').length, 6);
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 0);
  tago.locations.set(route, [locationItem('충남71자1001', 9)]);
  await live.tick(NOW + MINUTE);
  // 순번 10(한기대)을 조회 사이에 지나쳤다 → 9→11 사이 보간(+30초).
  tago.locations.set(route, [locationItem('충남71자1001', 11)]);
  await live.tick(NOW + 2 * MINUTE);
  // 정류소에 있는 상태로 관측되면 관측 시각 그대로(보간 아님). 정류소 순번은 차량 보고로도 익힌다.
  tago.locations.set(route, [locationItem('충남71자1001', 34, 'CAB285000656')]);
  await live.tick(NOW + 3 * MINUTE);
  assert.deepEqual(rows(db, 'SELECT node_id, vehicle_no, arrived_at, estimated FROM arrivals ORDER BY arrived_at'), [
    { node_id: KOREATECH_SOUTH, vehicle_no: '충남71자1001', arrived_at: NOW + 90_000, estimated: 1 },
    { node_id: 'CAB285000656', vehicle_no: '충남71자1001', arrived_at: NOW + 3 * MINUTE, estimated: 0 },
  ]);
  assert.deepEqual(rows(db, "SELECT from_ord, seconds FROM samples WHERE node_id = 'CAB285000405' ORDER BY from_ord"), [
    { from_ord: 8, seconds: 90 },
    { from_ord: 9, seconds: 30 },
  ]);
  // 새 운행(순번 감소)은 이전 궤적과 잇지 않는다.
  tago.locations.set(route, [locationItem('충남71자1001', 2)]);
  await live.tick(NOW + 4 * MINUTE);
  tago.locations.set(route, [locationItem('충남71자1001', 3)]);
  await live.tick(NOW + 5 * MINUTE);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM arrivals').get()!.n, 2);
});

test('location mode estimates remain times from learned samples without the arrival API', async (t) => {
  const tago = mockTago(t);
  const { live, db } = memoryCityBus('location');
  const route = ROUTES['400S'].routeid;
  for (const seconds of [100, 120, 140]) {
    db.prepare('INSERT INTO samples (route_id, node_id, from_ord, observed_at, seconds) VALUES (?, ?, 9, ?, ?)').run(
      route,
      KOREATECH_SOUTH,
      NOW - MINUTE,
      seconds,
    );
  }
  tago.locations.set(route, [locationItem('충남71자2002', 9)]);
  await live.tick(NOW);
  const response = await readCityBusRemainTime(
    cityBusEnv(live),
    bus('bus_type=city&depart=koreatech&arrival=terminal'),
    NOW + MINUTE,
  );
  assert.deepEqual(await response?.json(), {
    bus_type: 'city',
    now_bus: { bus_number: 400, remain_time: 60 },
    next_bus: null,
  });
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 0);
  // 학습값이 없는 순번의 차량이면 도착 API로 대신한다.
  tago.locations.set(route, [locationItem('충남71자2002', 9), locationItem('충남71자3003', 4)]);
  await live.tick(NOW + MINUTE);
  tago.arrivals.set(KOREATECH_SOUTH, [arrivalItem(KOREATECH_SOUTH, '400S', 400, 6)]);
  const fallback = await readCityBusRemainTime(
    cityBusEnv(live),
    bus('bus_type=city&depart=koreatech&arrival=terminal'),
    NOW + MINUTE,
  );
  assert.deepEqual(await fallback?.json(), {
    bus_type: 'city',
    now_bus: { bus_number: 400, remain_time: 400 },
    next_bus: null,
  });
  // 위치 조회가 오래되면(150초 초과) 역시 도착 API다.
  const stale = await readCityBusRemainTime(
    cityBusEnv(live),
    bus('bus_type=city&depart=koreatech&arrival=terminal'),
    NOW + 4 * MINUTE,
  );
  assert.ok(stale);
  assert.equal(tago.calls.filter((call) => call === 'getSttnAcctoArvlPrearngeInfoList').length, 2);
});

test('location mode falls back to arrival polling for 30 minutes when the location API is refused', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('location');
  tago.failures.set('getRouteAcctoBusLcList', new Response('Forbidden', { status: 403 }));
  tago.failures.set('getRouteAcctoThrghSttnList', new Response('Forbidden', { status: 403 }));
  await live.tick(NOW);
  const count = (name: string) => tago.calls.filter((call) => call === name).length;
  assert.equal(count('getRouteAcctoBusLcList'), 6);
  assert.equal(count('getSttnAcctoArvlPrearngeInfoList'), 7);
  await live.tick(NOW + MINUTE);
  assert.equal(count('getRouteAcctoBusLcList'), 6);
  assert.equal(count('getSttnAcctoArvlPrearngeInfoList'), 14);
  // 같은 분에 cron이 겹쳐도 한 번만 조회한다.
  await live.tick(NOW + MINUTE + 5_000);
  assert.equal(count('getSttnAcctoArvlPrearngeInfoList'), 14);
  tago.failures.delete('getRouteAcctoBusLcList');
  await live.tick(NOW + 31 * MINUTE);
  assert.equal(count('getRouteAcctoBusLcList'), 12);
  assert.equal(count('getSttnAcctoArvlPrearngeInfoList'), 14);
  // 경유 노선은 하루 한 번(같은 날 재호출 없음).
  assert.equal(count('getSttnThrghRouteList'), 7);
});

test('daily route refresh retries failures after 30 minutes and keeps the Java default numbers meanwhile', async (t) => {
  const tago = mockTago(t);
  const { live } = memoryCityBus('off');
  tago.failures.set('getSttnThrghRouteList', new Response('busy', { status: 500 }));
  await live.tick(NOW);
  await live.tick(NOW + 10 * MINUTE);
  assert.equal(tago.calls.length, 7);
  assert.equal(live.routes()?.date, null);
  tago.failures.delete('getSttnThrghRouteList');
  await live.tick(NOW + 30 * MINUTE);
  assert.equal(tago.calls.length, 14);
  assert.deepEqual(live.routes()?.nodeRoutes.CAB285000655, [12, 400, 402, 405]);
  assert.deepEqual(live.routes()?.window, { start: 345, end: 1470 });
  assert.equal(Object.keys(live.routes()!.tracked).length, 6);
});

test('arrival history validates parameters', async (t) => {
  mockTago(t);
  const { live } = memoryCityBus('off');
  const env = cityBusEnv(live);
  for (const query of [
    'direction=north',
    'station=koreatech',
    'station=campus&direction=north',
    'station=koreatech&direction=up',
    'station=koreatech&direction=north&weeks=9',
    'station=koreatech&direction=north&weeks=0',
    'station=koreatech&direction=north&bus_number=4a',
  ]) {
    const response = await handleCityBusArrivalHistory(
      env,
      new URL(`https://api.test/bus/city/arrival-history?${query}`),
      NOW,
    );
    assert.equal(response.status, 400, query);
    assert.match(await response.text(), /"code":"ILLEGAL_ARGUMENT"/);
  }
  const through = await gateway.request(
    'https://api.test/bus/city/arrival-history?station=station&direction=south&weeks=1',
    {},
    env,
  );
  assert.equal(through.status, 200);
  assert.equal(through.headers.get('X-Koin-Backend'), 'workers');
  assert.equal(through.headers.get('Cache-Control'), 'no-store');
});
