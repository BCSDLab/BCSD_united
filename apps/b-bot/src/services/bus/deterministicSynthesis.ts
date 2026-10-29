import type { AnalysedWorkbook } from './excelAnalyzer';
import type { ArrivalTime, BusRoute } from './types';
import { headingLike } from './deterministicParser';

const REGIONS = ['천안', '청주', '세종'] as const;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const regionOf = (text = '') => REGIONS.find((name) => text.includes(name));

/** Parses a full "HH:MM" string into minutes since midnight, or null. */
const parseTime = (value: string) => {
  const matched = HHMM.exec(value);
  return matched ? Number(matched[1]) * 60 + Number(matched[2]) : null;
};

/** Returns the first "HH:MM" found in text as minutes since midnight, or null. */
const timeInText = (text: string) => {
  const matched = /([01]?\d|2[0-3]):([0-5]\d)/.exec(text);
  return matched ? Number(matched[1]) * 60 + Number(matched[2]) : null;
};

const formatTime = (minutes: number) => {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
};

/**
 * Collects "역순" return-route rules from the document. A rule means "the 하교
 * leg runs the 등교 route in reverse starting from {time}". Both the region and
 * the departure time are read from the source, never hardcoded.
 *
 * - REGULAR sections embed the rule in the title:
 *   "천안 지역 등교 / 하교(18:10 등교 노선 역순)"
 * - SEASONAL/VACATION sheets keep it in a note cell:
 *   "■ 하교는 역순으로 18:10 출발"
 */
function collectReturnRules(workbook: AnalysedWorkbook): Map<string, number> {
  const rules = new Map<string, number>();
  for (const sheet of workbook.sheets) {
    for (const cell of sheet.cells) {
      if (cell.merged_from) continue;
      const text = String(cell.value ?? '');
      if (!/역순/.test(text)) continue;
      const minutes = timeInText(text);
      if (minutes === null) continue;
      let region = regionOf(text);
      if (!region) {
        const above = sheet.cells
          .filter(
            (candidate) =>
              !candidate.merged_from &&
              candidate.column === cell.column &&
              candidate.row < cell.row &&
              candidate.row >= cell.row - 10 &&
              headingLike(candidate.value) &&
              regionOf(String(candidate.value)),
          )
          .sort((left, right) => right.row - left.row)[0];
        region = regionOf(String(above?.value ?? ''));
      }
      if (region) rules.set(region, minutes);
    }
  }
  return rules;
}

/**
 * Mirrors one 등교 route into its 하교 route. Timed stops get the symmetric
 * arrival time (departure + time between the stop and the campus arrival on the
 * way in, so drop-off times grow monotonically). Request stops are labelled
 * "하차", matching the explicit 하교 tables the source already publishes.
 *
 * **정류장 순서는 등교와 그대로 같게 둔다(뒤집지 않는다).** KOIN에 실제로
 * 반영할 때는 등교/하교가 한 문서의 route_info 배열 안에 같이 들어가야
 * 하는데(뒤에서 병합한다), 그러려면 두 방향이 같은 node_info 순서를 공유
 * 해야 각 위치의 도착시각이 같은 정류장을 가리킨다.
 */
function mirrorRoute(route: BusRoute, departure: number): BusRoute | undefined {
  const trips: Array<{
    name: string;
    running_days?: BusRoute['route_info'][number]['running_days'];
    arrival_time: ArrivalTime[];
  }> = [];
  for (const trip of route.route_info) {
    const last = trip.arrival_time.at(-1);
    if (typeof last !== 'string') return undefined;
    const lastMinutes = parseTime(last);
    if (lastMinutes === null) return undefined;
    trips.push({
      // WEEKDAYS 노선은 route_info[].name이 정확히 "하교"여야 KOIN
      // 사이트가 등교 역순 노선을 하교로 인식한다(원본 trip.name "등교"를
      // 그대로 베끼면 하교 노선도 "등교"로 잘못 분류된다).
      name: '하교',
      ...(trip.running_days ? { running_days: trip.running_days } : {}),
      arrival_time: trip.arrival_time.map((value) => {
        if (typeof value === 'string') {
          const valueMinutes = parseTime(value);
          if (valueMinutes !== null) return formatTime(departure + (lastMinutes - valueMinutes));
        }
        return value === null ? null : '하차';
      }),
    });
  }
  return {
    region: route.region,
    route_type: '하교',
    route_name: route.route_name,
    node_info: route.node_info,
    route_info: trips,
  };
}

/**
 * Appends the synthesized 하교 legs (등교 노선 역순) for regions whose source
 * describes the return route instead of listing it. Purely deterministic:
 * it only reads the 출발시각 and the 등교 timetable from the workbook.
 */
export function synthesizeReturnRoutes(routes: BusRoute[], workbook: AnalysedWorkbook, warnings: string[]): BusRoute[] {
  const departures = collectReturnRules(workbook);
  if (!departures.size) return routes;
  const out = [...routes];
  const existing = new Set<string>();
  for (const route of routes) if (route.route_type === '하교') existing.add(`${route.region}:${route.route_name}`);
  const synthesized = new Set<string>();
  for (const route of routes) {
    if (route.route_type !== '등교') continue;
    const departure = departures.get(route.region);
    if (departure === undefined) continue;
    const terminus = route.node_info.at(-1)?.name ?? '';
    if (!/대학|본교/.test(terminus)) continue;
    if (existing.has(`${route.region}:${route.route_name}`)) continue;
    const mirrored = mirrorRoute(route, departure);
    if (!mirrored) {
      warnings.push(`${route.region} ${route.route_name}: 종착 도착시각을 읽을 수 없어 하교 자동 생성을 건너뜁니다.`);
      continue;
    }
    out.push(mirrored);
    existing.add(`${route.region}:${route.route_name}`);
    synthesized.add(route.region);
  }
  for (const region of synthesized) {
    const departure = departures.get(region);
    warnings.push(`${region} 하교는 등교 노선 역순(${formatTime(departure ?? 0)} 출발)으로 자동 계산해 추가했습니다.`);
  }
  return out;
}
