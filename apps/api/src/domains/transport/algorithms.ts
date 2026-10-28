import { ApiError } from '@api/errors';

export const regions = { CHEONAN_ASAN: '천안・아산', CHEONGJU: '청주', SEOUL: '서울', DAEJEON_SEJONG: '대전・세종' } as const;
export const routeTypes = { SHUTTLE: '순환', WEEKDAYS: '주중', WEEKEND: '주말' } as const;
export const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
export const days = ['SUN', ...weekdays, 'SAT'];
export const stations = ['KOREATECH', 'STATION', 'TERMINAL'] as const;
export type Station = typeof stations[number];
export const aliases: Record<Station, string[]> = {
  KOREATECH: ['학교', '한기대', '코리아텍', '대학', '본교'],
  STATION: ['천안역', '천안역(학화호두과자)', '천안역A', '천안역B'],
  TERMINAL: ['터미널', '터미널(신세계 앞 횡단보도)', '야우리', '천안 터미널'],
};
const cityOffsets: Record<number,number> = {400:6,402:13,405:7};
export interface NodeInfo { name: string; detail: string | null }
export interface RouteInfo { name: string; detail: string | null; arrival_time: (string | null)[]; running_days: string[] | null }
export interface Shuttle { id: string; semester_type: string; region: keyof typeof regions; route_type: keyof typeof routeTypes; route_name: string; sub_name: string | null; node_info: NodeInfo[]; route_info: RouteInfo[] }
export interface CityTimetable { id: string; updated_at: string; bus_info: { number: number; depart_node: string; arrival_node: string }; bus_timetables: {day_of_week: string; depart_info: string[]}[] }
export interface Schedule { bus_type: string; bus_name: string; depart_time: string }
export function invalid(message = '잘못된 입력값이 포함되어 있습니다.'): never { throw new ApiError(400, 'INVALID_REQUEST_BODY', message); }
export function station(value: string): Station {
  const found = stations.find(s => s === value.toUpperCase() || aliases[s].filter(a => a !== '천안역A' && a !== '천안역B').includes(value));
  if (!found) throw new ApiError(404, 'NOT_FOUND', '버스 정류장이 존재하지 않습니다.');
  return found;
}
export function kst(now: number) {
  return new Date(now + 9 * 3600000);
}
export function calendar(now: number) {
  return kst(now).toISOString().slice(0, 10);
}
export function clockSeconds(now: number) {
  const local = kst(now);
  return local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds() + local.getUTCMilliseconds() / 1000;
}
export function minutes(value: string | null | undefined): number | null {
  if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) return null;
  const [hours, mins] = value.trim().split(':').map(Number);
  return hours! * 60 + mins!;
}
/** 분 단위 값을 `HH:MM`으로 만든다. 음수나 1440 이상은 하루 안으로 되돌린다. */
export function time(value: number) {
  const wrapped = ((value % 1440) + 1440) % 1440;
  return `${Math.floor(wrapped / 60).toString().padStart(2, '0')}:${(wrapped % 60).toString().padStart(2, '0')}`;
}
export function localSeconds(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/.test(value)) invalid('버스 도착 시각이 잘못되었습니다.');
  const parts = value.split(':');
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2] ?? 0);
}
export function addMinutes(value: string, offset: number): string {
  const seconds = localSeconds(value);
  const minute = Math.floor(seconds / 60);
  const suffix = value.slice(5);
  return time(minute + offset) + (Number(value.slice(6)) === 0 ? '' : suffix);
}
export function cityOffset(number: number, depart: Station) { return depart === 'STATION' ? 7 : depart === 'KOREATECH' ? (cityOffsets[number] ?? 0) : 0; }
export function selectOccurrences(names: (string | null)[], times: (string | null)[], type: string, direction: string | null, depart: Station, arrival: Station) {
  const result: { departureIndex: number; arrivalIndex: number; departureTime: string }[] = [];
  if (depart === arrival || !Array.isArray(names) || !Array.isArray(times) || !names.length || names.length !== times.length) return result;
  const matches = (s: Station, n: string | null | undefined) => n != null && aliases[s].includes(n.trim());
  const campus = (i: number) => matches('KOREATECH', names[i]) && minutes(times[i]) !== null;
  const reverse = type === 'WEEKDAYS' && (direction === '하교' ? campus(names.length - 1) && !campus(0) : direction === '등교' && campus(0) && !campus(names.length - 1));
  const indexes = names.map((_, i) => i); if (reverse) indexes.reverse();
  for (let p = 0; p < indexes.length; p++) {
    const i = indexes[p]!; if (times[i]?.trim() === '종점') break;
    const departure = minutes(times[i]); if (!matches(depart, names[i]) || departure === null) continue;
    for (let q = p + 1; q < indexes.length; q++) {
      const j = indexes[q]!; const raw = times[j]?.trim(); const at = minutes(raw);
      if (matches(arrival, names[j]) && (['도착', '하차', '승하차', '정차', '종점'].includes(raw ?? '') || (at !== null && at > departure))) {
        result.push({departureIndex: i, arrivalIndex: j, departureTime: time(departure)}); break;
      }
      if (raw === '종점') break;
    }
  }
  return result;
}
export function shuttleSchedule(tables: Shuttle[], date: string, depart: Station, arrival: Station, legacyType?: string): Schedule[] {
  const day = days[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return tables.filter(t => t.region === 'CHEONAN_ASAN' && (!legacyType || (legacyType === 'commuting' ? t.route_type === 'WEEKDAYS' : t.route_type !== 'WEEKDAYS'))).flatMap(t => (t.route_info ?? []).flatMap(r => {
    if (!r || t.route_name === '미운행' || r.name === '미운행' || !day || !r.running_days?.includes(day) || !Array.isArray(t.node_info) || !Array.isArray(r.arrival_time)) return [];
    return [...new Set(selectOccurrences(t.node_info.map(n => n?.name ?? null), r.arrival_time, t.route_type, t.route_type === 'WEEKDAYS' ? r.name : r.detail, depart, arrival).map(o => o.departureTime))].map(depart_time => ({bus_type:'shuttle',bus_name:t.route_name,depart_time}));
  }));
}
/**
 * 부분 수정은 회차 이름으로 기존 회차를 찾아 덮어쓴다. 요청에서 생략한 회차는 그대로 두므로,
 * 회차 일부만 보낼 때는 정류장 이름·순서를 바꿀 수 없다(생략된 회차의 도착 시각이 정류장 순서에 묶여 있다).
 */
export function mergePartial(existing: Shuttle, nodes: NodeInfo[], routes: RouteInfo[]): Shuttle {
  const indices = new Map<string, number[]>();
  existing.route_info.forEach((route, index) => indices.set(route.name, [...(indices.get(route.name) ?? []), index]));
  const counts = new Map<string, number>();
  const matched: number[] = [];
  for (const route of routes) {
    const count = counts.get(route.name) ?? 0;
    const index = indices.get(route.name)?.[count];
    if (index === undefined) invalid('부분 수정에서는 기존 회차 이름만 변경할 수 있습니다.');
    matched.push(index);
    counts.set(route.name, count + 1);
  }
  for (const [name, count] of counts) {
    const existingCount = indices.get(name)!.length;
    if (existingCount !== count && (existingCount > 1 || count > 1)) invalid(`동일한 회차 이름의 기존 회차 수와 요청 회차 수가 다릅니다: ${name}`);
  }
  const nodesChanged = nodes.length !== existing.node_info.length || nodes.some((node, index) => node.name !== existing.node_info[index]?.name);
  if (matched.length !== existing.route_info.length && nodesChanged) invalid('생략된 회차가 있는 부분 수정에서는 정류장 이름과 순서를 변경할 수 없습니다.');
  const oldNodes = new Map<string, NodeInfo[]>();
  existing.node_info.forEach((node) => oldNodes.set(node.name, [...(oldNodes.get(node.name) ?? []), node]));
  const mergedNodes = nodes.map((node) => {
    const old = oldNodes.get(node.name)?.shift();
    return { ...node, detail: node.detail ?? old?.detail ?? null };
  });
  const mergedRoutes = existing.route_info.map((route) => ({ ...route }));
  routes.forEach((route, index) => {
    const old = mergedRoutes[matched[index]!]!;
    mergedRoutes[matched[index]!] = { ...route, detail: route.detail ?? old.detail, running_days: route.running_days?.length ? route.running_days : old.running_days };
  });
  return { ...existing, node_info: mergedNodes, route_info: mergedRoutes };
}
export function runningDays(name: string, detail: string | null) {
  const text = `${name ?? ''} ${detail ?? ''}`.trim();
  const labels = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const explicit = labels.flatMap((label, i) => text.includes(label) ? [days[i]!] : []);
  if (/(?<![가-힣])목(?:요일)?(?:[\s·・,，/／\-~]+)?금(?:요일)?(?=추가|[^가-힣]|$)/.test(text)) {
    if (explicit.some(d => d !== 'THU' && d !== 'FRI')) invalid(`운행 요일이 서로 충돌합니다: ${text}`); return ['THU', 'FRI'];
  }
  if (explicit.length > 1) invalid(`운행 요일이 서로 충돌합니다: ${text}`);
  return explicit.length ? explicit : [...weekdays];
}
export const expressRouteTimes = {
  KOREATECH: ['08:35','10:35','11:05','11:35','13:35','14:35','15:05','16:35','17:35','19:05','19:35','21:05','22:05'],
  TERMINAL: ['07:00','08:30','09:00','10:00','12:00','12:30','13:00','15:00','16:00','16:40','18:00','19:30','20:30'],
};
export const expressCacheTimes = {
  KOREATECH: ['08:35','09:35','10:35','11:35','13:35','14:35','15:35','16:35','17:35','18:35','19:35','20:35','22:05'],
  TERMINAL: ['07:00','08:30','09:00','10:00','11:00','12:00','13:00','15:00','16:00','17:00','18:00','19:00','20:30'],
};
