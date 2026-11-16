import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import gateway from '@api/koin-db/gateway';
import type { Bindings } from '@api/runtime';
import { cityBusKey, readCityBusTimetable } from './city-bus';

const DAYS = ['평일', '주말', '공휴일', '임시'];

function snapshot(busNumber: number, direction: string, times: string[][]) {
  return {
    schemaVersion: 1,
    kind: 'city_bus',
    busNumber,
    direction,
    routeId: 285000143,
    departNode: '병천3리',
    arrivalNode: direction,
    updatedAt: '2026-11-15 00:00:08',
    sourceURL: 'https://its.cheonan.go.kr/bis/showBusTimeTable.do',
    records: DAYS.map((dayOfWeek, index) => ({ dayOfWeek, departInfo: times[index] ?? [] })),
  };
}

function kv(values: Record<string, unknown>, fail = false) {
  const reads: string[] = [];
  const namespace = {
    get: async (key: string, type?: string) => {
      reads.push(key);
      if (fail) throw new Error('kv unavailable');
      assert.equal(type, 'json');
      return Object.hasOwn(values, key) ? structuredClone(values[key]) : null;
    },
  } as unknown as KVNamespace;
  return { namespace, reads };
}

function env(values: Record<string, unknown>, fail = false) {
  const store = kv(values, fail);
  return {
    store,
    bindings: {
      ENVIRONMENT: 'preview',
      KOIN_DB_ENABLED: 'true',
      AUTH_ALLOWED_ORIGINS: 'https://stage.koreatech.in',
      BATCH_KV: store.namespace,
    } as Bindings,
  };
}

const query = (busNumber: string, direction: string) =>
  new URL(`https://api.test/bus/timetable/city?bus_number=${busNumber}&direction=${encodeURIComponent(direction)}`);

type Timetable = {
  bus_info: { number: number; depart_node: string; arrival_node: string };
  bus_timetables: { day_of_week: string; depart_info: string[] }[];
};

async function served(response: Response | null): Promise<Timetable> {
  assert.ok(response);
  // Worker가 만든 본문이다. 필드 순서·전체 바이트 비교는 첫 테스트가 맡는다.
  const body: Timetable = JSON.parse(await response.text());
  return body;
}

test('terminal-bound timetables add the Java Koreatech offset, wrap at midnight and keep Java field order', async () => {
  const { bindings } = env({
    [cityBusKey(400, '종합터미널')]: snapshot(400, '종합터미널', [['06:00', '23:58'], [], ['22:35'], ['06:00']]),
  });
  const response = await readCityBusTimetable(bindings, query('400', '종합터미널'));
  assert.equal(response!.status, 200);
  assert.equal(
    await response!.text(),
    '{"updated_at":"2026-11-15 00:00:08","bus_info":{"number":400,"depart_node":"코리아텍","arrival_node":"천안 터미널"},' +
      '"bus_timetables":[{"day_of_week":"평일","depart_info":["06:06","00:04"]},{"day_of_week":"주말","depart_info":[]},' +
      '{"day_of_week":"공휴일","depart_info":["22:41"]},{"day_of_week":"임시","depart_info":["06:06"]}]}',
  );
});

test('offsets are per bus for the terminal direction and zero for Koreatech-bound directions', async () => {
  const { bindings } = env({
    [cityBusKey(402, '종합터미널')]: snapshot(402, '종합터미널', [['07:10', '18:40']]),
    [cityBusKey(405, '종합터미널')]: snapshot(405, '종합터미널', [['06:25']]),
    [cityBusKey(402, '황사동')]: snapshot(402, '황사동', [['06:05']]),
    [cityBusKey(400, '병천3리')]: snapshot(400, '병천3리', [['06:00']]),
    [cityBusKey(405, '유관순열사사적지')]: snapshot(405, '유관순열사사적지', [['06:10']]),
  });
  const first = async (busNumber: string, direction: string) => {
    const body = await served(await readCityBusTimetable(bindings, query(busNumber, direction)));
    return [body.bus_info.depart_node, body.bus_info.arrival_node, body.bus_timetables[0]!.depart_info];
  };
  assert.deepEqual(await first('402', '종합터미널'), ['코리아텍', '천안 터미널', ['07:23', '18:53']]);
  assert.deepEqual(await first('405', '종합터미널'), ['코리아텍', '천안 터미널', ['06:32']]);
  assert.deepEqual(await first('402', '황사동'), ['천안 터미널', '코리아텍', ['06:05']]);
  assert.deepEqual(await first('400', '병천3리'), ['천안 터미널', '코리아텍', ['06:00']]);
  assert.deepEqual(await first('405', '유관순열사사적지'), ['천안 터미널', '코리아텍', ['06:10']]);
});

test('leading zeros map to the canonical number like Java Long', async () => {
  const { bindings, store } = env({ [cityBusKey(400, '병천3리')]: snapshot(400, '병천3리', [['06:00']]) });
  const body = await served(await readCityBusTimetable(bindings, query('0400', '병천3리')));
  assert.equal(body.bus_info.number, 400);
  assert.deepEqual(store.reads, ['bus:city:v1:400:병천3리']);
});

test('noncanonical parameters, KV misses, KV errors and invalid snapshots defer to Java', async () => {
  const valid = snapshot(400, '종합터미널', [['06:00']]);
  for (const [values, url, fail] of [
    [{}, query('400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('400', '종합터미널'), true],
    [{ [cityBusKey(400, '종합터미널')]: { ...valid, busNumber: 402 } }, query('400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: { ...valid, direction: '병천3리' } }, query('400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: { ...valid, kind: 'notices' } }, query('400', '종합터미널'), false],
    [
      { [cityBusKey(400, '종합터미널')]: { ...valid, updatedAt: '2026-11-15T00:00:08' } },
      query('400', '종합터미널'),
      false,
    ],
    [{ [cityBusKey(400, '종합터미널')]: snapshot(400, '종합터미널', [['24:10']]) }, query('400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, new URL('https://api.test/bus/timetable/city?bus_number=400'), false],
    [
      { [cityBusKey(400, '종합터미널')]: valid },
      new URL('https://api.test/bus/timetable/city?direction=%EC%A2%85%ED%95%A9%ED%84%B0%EB%AF%B8%EB%84%90'),
      false,
    ],
    [{ [cityBusKey(400, '종합터미널')]: valid }, new URL(`${query('400', '종합터미널')}&bus_number=402`), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, new URL(`${query('400', '종합터미널')}&direction=x`), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('+400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('0x190', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('400.0', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('-400', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('9999999999999999', '종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('400', ' 종합터미널'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('400', 'toString'), false],
    [{ [cityBusKey(400, '종합터미널')]: valid }, query('400', ''), false],
  ] as const) {
    const { bindings } = env(values, fail);
    assert.equal(await readCityBusTimetable(bindings, url), null, url.search);
  }
  assert.equal(await readCityBusTimetable({} as Bindings, query('400', '종합터미널')), null);
});

function javaFetch(t: TestContext) {
  const seen: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    seen.push(request);
    return Response.json({ code: '', message: 'java' }, { status: 404 });
  });
  return seen;
}

test('gateway serves KV hits from Workers for anonymous and credentialed callers with CORS', async (t) => {
  const seen = javaFetch(t);
  const { bindings } = env({ [cityBusKey(402, '황사동')]: snapshot(402, '황사동', [['06:05', '17:30']]) });
  const variants: Record<string, string>[] = [{}, { Authorization: 'Bearer java-token', Cookie: 'session=java' }];
  for (const headers of variants) {
    const response = await gateway.request(
      `https://koin-api.workers.dev${query('402', '황사동').pathname}${query('402', '황사동').search}`,
      { headers: { ...headers, Origin: 'https://stage.koreatech.in' } },
      bindings,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Koin-Backend'), 'workers');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://stage.koreatech.in');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.match(response.headers.get('Content-Type')!, /^application\/json/);
    assert.equal((await served(response)).bus_timetables[0]!.depart_info.join(), '06:05,17:30');
  }
  assert.equal(seen.length, 0);
});

test('gateway forwards KV misses and invalid parameters unchanged to Java', async (t) => {
  const seen = javaFetch(t);
  const { bindings } = env({});
  for (const search of ['?bus_number=400&direction=%ED%99%A9%EC%82%AC%EB%8F%99', '?bus_number=abc&direction=x', '']) {
    const response = await gateway.request(`https://koin-api.workers.dev/bus/timetable/city${search}`, {}, bindings);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Koin-Backend'), 'aws');
    assert.equal(seen.at(-1)!.url, `https://api.stage.koreatech.in/bus/timetable/city${search}`);
  }
  const post = await gateway.request(
    'https://koin-api.workers.dev/bus/timetable/city?bus_number=400&direction=%EC%A2%85%ED%95%A9%ED%84%B0%EB%AF%B8%EB%84%90',
    { method: 'POST' },
    env({ [cityBusKey(400, '종합터미널')]: snapshot(400, '종합터미널', [['06:00']]) }).bindings,
  );
  assert.equal(post.headers.get('X-Koin-Backend'), 'aws');
  assert.equal(seen.length, 4);
});
