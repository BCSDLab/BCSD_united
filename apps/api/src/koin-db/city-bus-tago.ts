import { z } from 'zod';

/**
 * 국토교통부 TAGO 버스 Open API(apis.data.go.kr/1613000) 클라이언트. 천안시 cityCode 34010.
 * 키는 data.go.kr "Decoding" 인증키다(URLSearchParams가 한 번만 인코딩한다).
 * 오류 응답(키 만료 시 XML·resultCode≠00)은 TagoError로 던지고 본문은 노출하지 않는다.
 */
export const CHEONAN_CITY_CODE = '34010';
const BASE = 'https://apis.data.go.kr/1613000/';
const TIMEOUT_MS = 5000;

export class TagoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagoError';
  }
}

const text = z.union([z.string(), z.number()]).transform(String);
const integer = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number);

/** 버스위치정보 getRouteAcctoBusLcList. nodeord는 차량이 마지막으로 도착한 정류소 순번이다. */
const location = z.object({ nodeid: text, nodeord: integer, vehicleno: text });
/** 버스노선정보 getRouteAcctoThrghSttnList. */
const routeStop = z.object({ nodeid: text, nodeord: integer });
/** 버스정류소정보 getSttnThrghRouteList(Java CityBusRoute). */
const throughRoute = z.object({ routeid: text, routeno: text });
/** 버스도착정보 getSttnAcctoArvlPrearngeInfoList(Java CityBusArrival). arrtime은 초, arrprevstationcnt는 남은 정류소 수. */
const arrival = z.object({
  nodeid: text,
  routeid: text,
  routeno: text,
  arrtime: integer,
  arrprevstationcnt: integer.optional(),
});

export type TagoLocation = z.infer<typeof location>;
export type TagoRouteStop = z.infer<typeof routeStop>;
export type TagoThroughRoute = z.infer<typeof throughRoute>;
export type TagoArrival = z.infer<typeof arrival>;

const envelope = z.object({
  response: z.object({
    header: z.object({ resultCode: z.string() }),
    body: z
      .object({
        totalCount: integer.optional(),
        // 결과 0건이면 items가 빈 문자열, 1건이면 item이 배열이 아닌 객체다.
        items: z.union([z.literal(''), z.object({ item: z.unknown().optional() })]).optional(),
      })
      .optional(),
  }),
});

async function items<T>(key: string, endpoint: string, params: Record<string, string>, schema: z.ZodType<T>) {
  const url = new URL(endpoint, BASE);
  url.search = new URLSearchParams({
    serviceKey: key,
    _type: 'json',
    pageNo: '1',
    cityCode: CHEONAN_CITY_CODE,
    ...params,
  }).toString();
  let body: unknown;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new TagoError(`TAGO ${endpoint} HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    if (error instanceof TagoError) throw error;
    throw new TagoError(`TAGO ${endpoint} request failed`);
  }
  const parsed = envelope.safeParse(body);
  if (!parsed.success || parsed.data.response.header.resultCode !== '00') {
    throw new TagoError(`TAGO ${endpoint} returned an error`);
  }
  // 빈 문자열 items는 falsy라 0건이다.
  const raw = parsed.data.response.body?.items ? parsed.data.response.body.items.item : undefined;
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  // 항목 하나가 스키마와 다르면 그 항목만 버린다(Java는 노드 전체를 실패 처리하지만 나머지는 유효하다).
  return list.flatMap((item) => {
    const value = schema.safeParse(item);
    return value.success ? [value.data] : [];
  });
}

export const tago = {
  busLocations: (key: string, routeId: string) =>
    items(key, 'BusLcInfoInqireService/getRouteAcctoBusLcList', { routeId, numOfRows: '100' }, location),
  routeStops: (key: string, routeId: string) =>
    items(key, 'BusRouteInfoInqireService/getRouteAcctoThrghSttnList', { routeId, numOfRows: '300' }, routeStop),
  throughRoutes: (key: string, nodeId: string) =>
    items(key, 'BusSttnInfoInqireService/getSttnThrghRouteList', { nodeid: nodeId, numOfRows: '50' }, throughRoute),
  arrivals: (key: string, nodeId: string) =>
    items(key, 'ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList', { nodeId, numOfRows: '30' }, arrival),
};
