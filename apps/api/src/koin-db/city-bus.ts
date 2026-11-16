import { z } from 'zod';
import type { Bindings } from '@api/runtime';

// Java CityBusDirection: 이름(조회 키 arrival_node) → 응답 bus_info의 depart_node/arrival_node.
export const DIRECTIONS: Readonly<Record<string, readonly [string, string]>> = {
  종합터미널: ['코리아텍', '천안 터미널'],
  병천3리: ['천안 터미널', '코리아텍'],
  황사동: ['천안 터미널', '코리아텍'],
  유관순열사사적지: ['천안 터미널', '코리아텍'],
};
// CityBusTimetable.applyTimeOffset: 기점 시각에 기점→한기대 이동 시간을 더한다(터미널행만).
const KOREATECH_OFFSET_MINUTES: Readonly<Record<number, number>> = { 400: 6, 402: 13, 405: 7 };

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
// Pi 배치(school_kv.city_bus)가 ingest Worker로 쓰는 스냅샷. Mongo citybus_timetables 문서와 같은 내용이다.
export const snapshot = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('city_bus'),
  busNumber: z.number().int().positive(),
  direction: z.string(),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  records: z.array(z.object({ dayOfWeek: z.string(), departInfo: z.array(time) })),
});

export const cityBusKey = (busNumber: number, direction: string) => `bus:city:v1:${busNumber}:${direction}`;

// LocalTime.plusMinutes는 자정을 넘기면 순환하고, 초가 0이면 toString은 HH:mm이다.
function shift(value: string, minutes: number): string {
  if (!minutes) return value;
  const total = (Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * GET /bus/timetable/city를 KV 스냅샷으로 Java와 같은 JSON으로 응답한다.
 * 정규형이 아닌 파라미터(중복·공백·부호·16진수 등 Spring 변환 규칙)나 스냅샷 누락·손상·조회 실패는
 * null을 반환해 Java가 원래 오류/응답을 그대로 내게 한다.
 */
export async function readCityBusTimetable(env: Bindings, url: URL): Promise<Response | null> {
  const numbers = url.searchParams.getAll('bus_number');
  const directions = url.searchParams.getAll('direction');
  if (!env.BATCH_KV || numbers.length !== 1 || directions.length !== 1) return null;
  const [rawNumber] = numbers as [string];
  const [direction] = directions as [string];
  if (!/^\d{1,15}$/.test(rawNumber) || !Object.hasOwn(DIRECTIONS, direction)) return null;
  const busNumber = Number(rawNumber);
  let cached: unknown;
  try {
    cached = await env.BATCH_KV.get(cityBusKey(busNumber, direction), 'json');
  } catch {
    return null;
  }
  const parsed = snapshot.safeParse(cached);
  if (!parsed.success || parsed.data.busNumber !== busNumber || parsed.data.direction !== direction) return null;
  const offset = direction === '종합터미널' ? (KOREATECH_OFFSET_MINUTES[busNumber] ?? 0) : 0;
  const [departNode, arrivalNode] = DIRECTIONS[direction]!;
  // 필드 순서는 Java CityBusTimetableResponse 레코드 선언 순서와 같다.
  return Response.json({
    updated_at: parsed.data.updatedAt,
    bus_info: { number: busNumber, depart_node: departNode, arrival_node: arrivalNode },
    bus_timetables: parsed.data.records.map((record) => ({
      day_of_week: record.dayOfWeek,
      depart_info: record.departInfo.map((value) => shift(value, offset)),
    })),
  });
}
