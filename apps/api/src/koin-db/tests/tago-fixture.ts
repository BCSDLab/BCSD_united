import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { cityBusKey } from '@api/koin-db/city-bus';
import { CityBusLive, type TrackingMode } from '@api/koin-db/city-bus-live';
import type { Bindings } from '@api/runtime';

/**
 * TAGO 응답 기록(공공데이터포털 문서 스키마: response.header/body.items.item, 숫자 routeno·nodeord).
 * 노선 ID는 400·402·405의 방향별(→병천권, →종합터미널) 가상 ID, 12번은 추적하지 않는 노선이다.
 */
export const ROUTES = {
  '400N': { routeid: 'CAB285000142', routeno: 400, startnodenm: '종합터미널', endnodenm: '병천3리' },
  '400S': { routeid: 'CAB285000143', routeno: 400, startnodenm: '병천3리', endnodenm: '종합터미널' },
  '402N': { routeid: 'CAB285000144', routeno: 402, startnodenm: '종합터미널', endnodenm: '황사동' },
  '402S': { routeid: 'CAB285000145', routeno: 402, startnodenm: '황사동', endnodenm: '종합터미널' },
  '405N': { routeid: 'CAB285000146', routeno: 405, startnodenm: '종합터미널', endnodenm: '유관순열사사적지' },
  '405S': { routeid: 'CAB285000147', routeno: 405, startnodenm: '유관순열사사적지', endnodenm: '종합터미널' },
  '12N': { routeid: 'CAB285000012', routeno: 12, startnodenm: '종합터미널', endnodenm: '천안역' },
  '12S': { routeid: 'CAB285000013', routeno: 12, startnodenm: '천안역', endnodenm: '종합터미널' },
} as const;
type RouteName = keyof typeof ROUTES;

const north: RouteName[] = ['400N', '402N', '405N'];
const south: RouteName[] = ['400S', '402S', '405S'];
/** 정류소별 경유 노선(getSttnThrghRouteList). */
export const THROUGH: Record<string, RouteName[]> = {
  CAB285000406: north,
  CAB285000405: south,
  CAB285000655: [...north, '12N'],
  CAB285000656: [...south, '12S'],
  CAB285000686: [...north, '12N'],
  CAB285000685: [...south, '12S'],
  CAB285010125: ['12S'],
};
/** 노선별 대상 정류소 순번(getRouteAcctoThrghSttnList). */
export const STOPS: Record<string, [string, number][]> = {
  CAB285000142: [
    ['CAB285000686', 1],
    ['CAB285000655', 6],
    ['CAB285000406', 30],
  ],
  CAB285000143: [
    ['CAB285000405', 10],
    ['CAB285000656', 34],
    ['CAB285000685', 40],
  ],
  CAB285000144: [
    ['CAB285000686', 1],
    ['CAB285000655', 6],
    ['CAB285000406', 28],
  ],
  CAB285000145: [
    ['CAB285000405', 14],
    ['CAB285000656', 36],
    ['CAB285000685', 42],
  ],
  CAB285000146: [
    ['CAB285000686', 1],
    ['CAB285000655', 6],
    ['CAB285000406', 31],
  ],
  CAB285000147: [
    ['CAB285000405', 9],
    ['CAB285000656', 33],
    ['CAB285000685', 39],
  ],
};

export function ok(items: unknown[]) {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
      body: {
        // 0건이면 빈 문자열, 1건이면 배열이 아닌 객체다.
        items: items.length === 0 ? '' : { item: items.length === 1 ? items[0] : items },
        numOfRows: 30,
        pageNo: 1,
        totalCount: items.length,
      },
    },
  };
}

/** 키 미승인·만료 시 data.go.kr 게이트웨이가 _type=json이어도 내려주는 XML. */
export const NOT_REGISTERED = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>
<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;

export const arrivalItem = (node: string, route: RouteName, arrtime: number, remaining: number) => ({
  arrprevstationcnt: remaining,
  arrtime,
  nodeid: node,
  nodenm: '코리아텍',
  routeid: ROUTES[route].routeid,
  routeno: ROUTES[route].routeno,
  routetp: '일반버스',
  vehicletp: '일반차량',
});

export const locationItem = (
  vehicle: string,
  nodeord: number,
  nodeid = `CAB2850009${String(nodeord).padStart(2, '0')}`,
) => ({
  gpslati: 36.7631,
  gpslong: 127.2817,
  nodeid,
  nodenm: '중간정류소',
  nodeord,
  routenm: 400,
  routetp: '일반버스',
  vehicleno: vehicle,
});

export interface TagoWorld {
  arrivals: Map<string, unknown[]>;
  locations: Map<string, unknown[]>;
  /** 엔드포인트 이름(getRouteAcctoBusLcList 등) → 강제 응답. */
  failures: Map<string, Response>;
  calls: string[];
}

/** apis.data.go.kr만 응답하는 fetch. 다른 호스트는 실패시킨다. */
export function mockTago(t: TestContext): TagoWorld {
  const world: TagoWorld = { arrivals: new Map(), locations: new Map(), failures: new Map(), calls: [] };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== 'apis.data.go.kr') throw new Error(`unexpected fetch ${url.host}`);
    const endpoint = url.pathname.split('/').pop()!;
    world.calls.push(endpoint);
    if (url.searchParams.get('serviceKey') !== 'test-key' || url.searchParams.get('cityCode') !== '34010') {
      return new Response(NOT_REGISTERED, { headers: { 'Content-Type': 'text/xml' } });
    }
    const failure = world.failures.get(endpoint);
    if (failure) return failure.clone();
    let items: unknown[];
    if (endpoint === 'getSttnThrghRouteList') {
      items = (THROUGH[url.searchParams.get('nodeid')!] ?? []).map((name) => ({
        ...ROUTES[name],
        routetp: '일반버스',
      }));
    } else if (endpoint === 'getRouteAcctoThrghSttnList') {
      const routeId = url.searchParams.get('routeId')!;
      items = (STOPS[routeId] ?? []).map(([nodeid, nodeord]) => ({
        gpslati: 36.76,
        gpslong: 127.28,
        nodeid,
        nodenm: '정류소',
        nodeno: 10000 + nodeord,
        nodeord,
        routeid: routeId,
        updowncd: 0,
      }));
    } else if (endpoint === 'getSttnAcctoArvlPrearngeInfoList') {
      items = world.arrivals.get(url.searchParams.get('nodeId')!) ?? [];
    } else if (endpoint === 'getRouteAcctoBusLcList') {
      items = world.locations.get(url.searchParams.get('routeId')!) ?? [];
    } else {
      throw new Error(`unexpected endpoint ${endpoint}`);
    }
    return Response.json(ok(items));
  });
  return world;
}

/** BATCH_KV 시내버스 시간표: 기점 첫차 06:00, 막차 22:30 → 운행 시간 05:45 ~ 익일 00:30. */
export function timetableKv() {
  const values = new Map<string, unknown>();
  for (const [number, direction] of [
    [400, '병천3리'],
    [400, '종합터미널'],
    [402, '황사동'],
  ] as const) {
    values.set(cityBusKey(number, direction), {
      schemaVersion: 1,
      kind: 'city_bus',
      busNumber: number,
      direction,
      updatedAt: '2026-11-15 00:00:08',
      records: [
        { dayOfWeek: '평일', departInfo: ['06:00', '08:10', '22:30'] },
        { dayOfWeek: '주말', departInfo: ['06:30', '21:00'] },
      ],
    });
  }
  return {
    get: async (key: string) => (values.has(key) ? structuredClone(values.get(key)) : null),
  } as unknown as KVNamespace;
}

/** node:sqlite로 DO SqlStorage를 흉내 낸 CityBusLive. db는 학습값 주입 등 직접 확인용이다. */
export function memoryCityBus(mode: TrackingMode, key: string | undefined = 'test-key') {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as Pick<SqlStorage, 'exec'>;
  const live = new CityBusLive(
    sql,
    (operation) => {
      db.exec('BEGIN');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    { key, kv: timetableKv(), mode },
  );
  return { live, db };
}

/** CITY_BUS 네임스페이스 대역: 모든 이름이 같은 CityBusLive로 간다. */
export function cityBusEnv(live: CityBusLive): Bindings {
  const namespace = {
    idFromName: (name: string) => name,
    get: () => live,
  } as unknown as DurableObjectNamespace;
  return {
    ENVIRONMENT: 'preview',
    KOIN_DB_ENABLED: 'true',
    AUTH_ALLOWED_ORIGINS: 'https://stage.koreatech.in',
    CITY_BUS: namespace,
  } as unknown as Bindings;
}
