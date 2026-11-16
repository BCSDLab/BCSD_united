import { captureError } from '@koin/telemetry/runtime';
import { ApiError, errorResponse } from '@api/errors';
import { STATION_NODES, STATIONS, type Direction, type Station } from '@api/koin-db/city-bus-live';
import type { Bindings } from '@api/runtime';

const HISTORY_MAX_WEEKS = 8;

function cityBusObject(env: Bindings) {
  if (!env.CITY_BUS) return null;
  // cron은 임의 지역에서 실행되므로 첫 생성 위치를 한국 가까이로 고정한다.
  return env.CITY_BUS.get(env.CITY_BUS.idFromName('cheonan'), { locationHint: 'apac' });
}

/** cron 1분마다. 경유 노선 하루 한 번, 운행 시간 수집은 DO가 판단한다. */
export async function tickCityBus(env: Bindings, now: number): Promise<void> {
  await cityBusObject(env)?.tick(now);
}

/** 값이 정확히 하나일 때만(Spring 변환과 다르게 해석할 여지가 없는 경우). */
function single(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

// Java BusStationEnumConverter: 이름 대소문자 무시 일치.
const station = (value: string | null): Station | null =>
  STATIONS.find((name) => value !== null && name === value.toUpperCase()) ?? null;

/**
 * Java GET /bus?bus_type=city&depart=&arrival= (BusRemainTimeResponse). 시내버스가 아니거나 파라미터가 비정규·동일
 * 정류소이거나 TAGO 조회에 실패하면 null을 반환해 Java가 응답(오류 포함)하게 한다.
 */
export async function readCityBusRemainTime(env: Bindings, url: URL, now = Date.now()): Promise<Response | null> {
  const type = single(url, 'bus_type');
  const depart = station(single(url, 'depart'));
  const arrival = station(single(url, 'arrival'));
  if (type?.toLowerCase() !== 'city' || !depart || !arrival || depart === arrival) return null;
  const object = cityBusObject(env);
  if (!object) return null;
  // BusStation.getDirection: 선언 순서상 출발이 앞이면 SOUTH.
  const direction: Direction = STATIONS.indexOf(depart) < STATIONS.indexOf(arrival) ? 'SOUTH' : 'NORTH';
  let entries;
  try {
    entries = await object.remain([...STATION_NODES[depart][direction]], [...STATION_NODES[arrival][direction]], now);
  } catch (error) {
    captureError(error);
    return null;
  }
  if (!entries) return null;
  const buses = entries
    .filter((entry) => entry.arrivalAt > now)
    .sort((a, b) => a.arrivalAt - b.arrivalAt)
    .map((entry) => ({ bus_number: entry.busNumber, remain_time: Math.floor((entry.arrivalAt - now) / 1000) }));
  // 필드 순서는 Java BusRemainTimeResponse 레코드 선언 순서다.
  return Response.json({ bus_type: 'city', now_bus: buses[0] ?? null, next_bus: buses[1] ?? null });
}

function invalid(message: string): never {
  throw new ApiError(400, 'ILLEGAL_ARGUMENT', message);
}

/**
 * GET /bus/city/arrival-history?station=&direction=&bus_number=&weeks=4
 * 지난 weeks주(1~8) 같은 요일, 현재 KST 시각 ±30분에 실제로 정류소에 도착한 시내버스 기록.
 */
export async function handleCityBusArrivalHistory(env: Bindings, url: URL, now = Date.now()): Promise<Response> {
  try {
    const target = station(single(url, 'station'));
    if (!target) invalid('station은 koreatech, station, terminal 중 하나여야 합니다.');
    const directionValue = single(url, 'direction')?.toUpperCase();
    if (directionValue !== 'NORTH' && directionValue !== 'SOUTH') invalid('direction은 north 또는 south여야 합니다.');
    const numberValue = url.searchParams.has('bus_number') ? single(url, 'bus_number') : null;
    if (url.searchParams.has('bus_number') && !/^\d{1,9}$/.test(numberValue ?? '')) {
      invalid('bus_number는 버스 번호여야 합니다.');
    }
    const weeksValue = url.searchParams.has('weeks') ? single(url, 'weeks') : '4';
    const weeks = /^\d{1,2}$/.test(weeksValue ?? '') ? Number(weeksValue) : 0;
    if (weeks < 1 || weeks > HISTORY_MAX_WEEKS) invalid(`weeks는 1~${HISTORY_MAX_WEEKS} 사이여야 합니다.`);
    const object = cityBusObject(env);
    if (!object) throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', '시내버스 저장소가 설정되지 않았습니다.');
    const busNumber = numberValue === null ? null : Number(numberValue);
    let days;
    try {
      days = await object.history({ nodes: [...STATION_NODES[target][directionValue]], busNumber, weeks, now });
    } catch (error) {
      captureError(error);
      throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', '시내버스 도착 기록 조회에 실패했습니다.');
    }
    return Response.json({
      bus_number: busNumber,
      station: target.toLowerCase(),
      direction: directionValue.toLowerCase(),
      weeks,
      base_time: new Date(now + 9 * 3_600_000).toISOString().slice(11, 16),
      window_minutes: 30,
      days,
    });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    throw error;
  }
}
