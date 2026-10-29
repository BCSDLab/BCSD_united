export const BUS_TARGETS = ['commuting', 'shuttle'] as const;
export const SEMESTER_TYPES = ['REGULAR', 'SEASONAL', 'VACATION'] as const;
export const ARRIVAL_MARKERS = ['도착', '정차', '미정차', '하차', '미하차', '승하차', '종점'] as const;

export type BusTarget = (typeof BUS_TARGETS)[number];
export type SemesterType = (typeof SEMESTER_TYPES)[number];
export type ArrivalTime = string | null;
export interface BusRoute {
  region: string;
  route_type: string;
  route_name: string;
  node_info: Array<{ name: string }>;
  route_info: Array<{
    name: string;
    arrival_time: ArrivalTime[];
    running_days?: Array<'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'>;
  }>;
}
export interface BusPayload {
  target: BusTarget;
  semester_type: SemesterType;
  body: Record<string, BusRoute[]>;
}
export interface BusVersionUpdate {
  type: 'shuttle_bus_timetable';
  title: '정규학기' | '계절학기' | '방학기간';
  content: string;
}
export interface BusConversion {
  payloads: BusPayload[];
  version_update: BusVersionUpdate;
  provenance: Record<string, unknown>;
  warnings: unknown[];
}

/**
 * 검토 페이지의 "전체 노선" 타일과 저장된 메타(`BusReviewMeta.routeCount`)가
 * 항상 같은 수를 보여줘야 한다. 각자 세면 언젠가 갈라진다.
 */
export function totalRouteCount(conversions: BusConversion[]): number {
  return conversions.reduce(
    (count, conversion) =>
      count + conversion.payloads.reduce((pc, payload) => pc + Object.values(payload.body)[0].length, 0),
    0,
  );
}
