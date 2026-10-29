import { generateStructured } from '@koin/b-bot-ai';
import { sourceDays, type Day } from './days';
import type { BusConversion, BusPayload, BusRoute, BusTarget, SemesterType } from './types';
import { ARRIVAL_MARKERS } from './types';
import { normalizeTime } from './validation';
import { BUS_REGIONS, clean } from './text';

const TITLES = ['정규학기', '계절학기', '방학기간'] as const;
const SEMESTER_OF: Record<string, SemesterType> = {
  정규학기: 'REGULAR',
  계절학기: 'SEASONAL',
  방학기간: 'VACATION',
};
const DAY_LABELS: Record<string, string> = {
  MON: '월',
  TUE: '화',
  WED: '수',
  THU: '목',
  FRI: '금',
  SAT: '토',
  SUN: '일',
};
const markers = new Set<string>(ARRIVAL_MARKERS);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PERIOD = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/;

export type BusPatchKind =
  | 'arrival_time'
  | 'route_name'
  | 'running_days'
  | 'period'
  | 'remove_route'
  | 'remove_trip'
  | 'remove_stop'
  | 'add_trip'
  | 'add_stop';

export interface BusPatch {
  semester: SemesterType;
  target: BusTarget;
  region: string;
  routeType: string;
  routeName: string;
  kind: BusPatchKind;
  tripName?: string;
  stopName?: string;
  before: string;
  after: string;
  rawValue: string;
  value?: string;
  days?: Day[];
  addStop?: { name: string; beforeStop?: string; afterStop?: string };
}

export interface BusPatchPlan {
  patches: BusPatch[];
  problems: string[];
}

const daysLabel = (days?: Day[]) => days?.map((d) => DAY_LABELS[d]).join(',') ?? '운행일 없음';

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['patches', 'unclear'],
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'semester',
          'region',
          'direction',
          'route',
          'field',
          'trip',
          'stop',
          'value',
          'days',
          'newStop',
          'referenceStop',
          'position',
        ],
        properties: {
          semester: {
            type: 'string',
            enum: [...TITLES],
            description: '바꿀 대상 학기. 원문에서 안 보이면 변환 목록에 하나뿐인 학기로 채운다.',
          },
          region: { type: 'string', description: `지역(${BUS_REGIONS.join('/')}). 모르면 빈 문자열.` },
          direction: { type: 'string', description: '등교/하교/셔틀. 모르면 빈 문자열.' },
          route: { type: 'string', description: '노선명. 사용자가 부른 그대로.' },
          field: {
            type: 'string',
            enum: [
              'arrival_time',
              'route_name',
              'running_days',
              'period',
              'remove_route',
              'remove_trip',
              'remove_stop',
              'add_trip',
              'add_stop',
            ],
            description: '무엇을 바꿀지. arrival_time은 특정 회차·정류장의 도착 시각, period는 적용 기간.',
          },
          trip: {
            type: 'string',
            description:
              '회차 이름(1회, 목·금 추가1 등). 해당 없으면 빈 문자열. ' +
              "'1회부터 7회까지'/'1~7회'처럼 회차 범위면 여러 patch로 나누지 말고 원문 그대로 여기 적는다 — 실제 회차와 맞는지는 코드가 확인해서 알아서 펼친다.",
          },
          stop: { type: 'string', description: '정류장 이름. 해당 없으면 빈 문자열.' },
          value: {
            type: 'string',
            description:
              '새 값. 도착시각은 HH:MM 또는 도착/정차/하차/종점 같은 마커, 기간은 YYYY-MM-DD~YYYY-MM-DD, 노선명·정류장명은 사용자가 부른 그대로.',
          },
          days: {
            type: 'string',
            description: 'running_days일 때 요일 표기(월수금, 주중, 매일 등). 해당 없으면 빈 문자열.',
          },
          newStop: { type: 'string', description: 'add_stop일 때 새 정류장 이름.' },
          referenceStop: { type: 'string', description: 'add_stop일 때 위치 기준이 되는 정류장 이름.' },
          position: {
            type: 'string',
            enum: ['before', 'after', ''],
            description: 'add_stop일 때 기준 정류장의 앞(before)/뒤(after).',
          },
        },
      },
    },
    unclear: {
      type: 'array',
      items: { type: 'string' },
      description: '무슨 뜻인지 확실하지 않아 손대지 않은 부분. 추측하지 말고 여기 적는다.',
    },
  },
} as const;

const SYSTEM_PROMPT = `너는 버스 시간표 수정 요청을 구조화하는 도구다.

사용자가 자연어로 말한 수정 사항을 항목 단위로 쪼갠다. 파싱으로 만든 버스 노선 데이터를
바꾸는 요청만 다룬다.

아래는 실제 존재하는 노선 목록이다. 한 줄이 노선 하나이고
"지역 | 방향 | 노선명 | 회차: 회차1, 회차2, ..." 형태다. 사용자가 지역·방향·노선명을
줄여 말해도 이 목록의 정확한 값으로 맞춰서 적는다. 목록에 없는 지역·방향·노선명·회차는
지어내지 마라. 예: 사용자가 "세종 등교 셔틀"이라 하면 목록에서 "세종" "등교" "세종 등교/하교"를 찾는다.

실제 노선 목록:
{{ROUTES}}

- 값을 지어내지 마라. 사용자가 말하지 않은 건 바꾸지 않는다.
- 한 문장에 여러 노선·항목이 있으면 각각 따로 적는다.
- 무슨 뜻인지 애매하면 patches에 넣지 말고 unclear에 적어라. 추측해서 바꾸면 되돌릴 방법이 없다.
- **예외: 회차 범위("1회부터 7회까지", "1~7회" 등)는 절대 unclear로 넘기지 마라.**
  노선 목록에 각 노선의 실제 회차 이름이 함께 나와 있으니 그걸 보고 판단해라 —
  범위에 맞는 회차들로 나눠 각각 patch를 적어도 되고, 자신 없으면 범위 텍스트를
  trip에 그대로 적어도 된다(그 경우 실제 회차와 맞는지는 코드가 다시 확인한다).
  둘 중 뭘 하든 좋으니, 노선(지역/방향/노선명)만 특정되면 unclear로 포기하지 마라.
- 도착시각은 HH:MM 또는 마커(도착/정차/하차/미정차/하차/승하차/종점)로 적는다.
- 적용 기간은 YYYY-MM-DD~YYYY-MM-DD 형태 그대로 적는다.
- 직전 대화가 함께 주어지면 참고만 해라. **지금 메시지가 요청하는 것만** 내놓는다.

바꿀 수 있는 항목: arrival_time(도착시각), route_name(노선명), running_days(운행요일),
period(적용기간), remove_route/remove_trip/remove_stop(노선/회차/정류장 삭제),
add_trip/add_stop(회차/정류장 추가)`;

interface RawPatch {
  semester: string;
  region: string;
  direction: string;
  route: string;
  field: string;
  trip: string;
  stop: string;
  value: string;
  days: string;
  newStop: string;
  referenceStop: string;
  position: string;
}
export type { RawPatch };

/** SemesterType ↔ 표시용 한글 학기명. 같은 노선명이 여러 학기에 걸쳐 있을 수 있어
 *  검토·수정 미리보기에서 어느 학기를 고쳤는지 반드시 같이 보여줘야 한다. */
export const TITLE_OF: Record<SemesterType, string> = {
  REGULAR: '정규학기',
  SEASONAL: '계절학기',
  VACATION: '방학기간',
};

function conversionBySemester(conversions: BusConversion[], semester: SemesterType): BusConversion | undefined {
  return conversions.find((conversion) => conversion.payloads.some((payload) => payload.semester_type === semester));
}

/** `conversionBySemester`와 달리 같은 학기가 여러 BusConversion에 걸쳐 있어도 전부 찾는다. */
function conversionsBySemester(conversions: BusConversion[], semester: SemesterType): BusConversion[] {
  return conversions.filter((conversion) => conversion.payloads.some((payload) => payload.semester_type === semester));
}

function semesterOfTitle(title: string): SemesterType | undefined {
  return SEMESTER_OF[clean(title)];
}

/**
 * conversions에 실제로 등장하는 학기 구분. LLM은 노선 목록({{ROUTES}})만 보고
 * 학기 정보는 못 보므로, 원문에 학기 언급이 없으면 십중팔구 "정규학기"로 찍는다
 * (실제로 계절학기·방학기간만 있는 파일이어도 마찬가지) — 그 hallucination을
 * 걸러내려면 파일에 학기가 실제로 몇 종류 있는지를 코드가 직접 세야 한다.
 * 하나의 학기라도 sheet/지역별로 BusConversion이 여러 개로 쪼개질 수 있어
 * `conversions.length === 1`은 대리 지표로 쓸 수 없다.
 */
function distinctSemesterTypes(conversions: BusConversion[]): SemesterType[] {
  const found = new Set<SemesterType>();
  for (const conversion of conversions) {
    for (const payload of conversion.payloads) found.add(payload.semester_type);
  }
  return [...found];
}

function routeCandidates(
  conversion: BusConversion,
  hints: { region: string; direction: string; route: string },
): Array<{ payload: BusPayload; payloadIndex: number; route: BusRoute; routeIndex: number }> {
  const wanted = clean(hints.route).toLowerCase();
  const candidates: Array<{ payload: BusPayload; payloadIndex: number; route: BusRoute; routeIndex: number }> = [];
  for (const [payloadIndex, payload] of conversion.payloads.entries()) {
    const routes = Object.values(payload.body)[0] ?? [];
    for (const [routeIndex, route] of routes.entries()) {
      if (wanted) {
        const routeName = clean(route.route_name).toLowerCase();
        if (!routeName.includes(wanted)) continue;
      }
      if (hints.region && !route.region.includes(clean(hints.region))) continue;
      if (hints.direction && clean(route.route_type) !== clean(hints.direction)) continue;
      candidates.push({ payload, payloadIndex, route, routeIndex });
    }
  }
  return candidates;
}

function describeRoute(route: BusRoute) {
  return `${route.region} ${route.route_type} "${route.route_name}"`;
}

function validateTime(value: string): string | undefined {
  const normalized = normalizeTime(clean(value));
  if (typeof normalized !== 'string') return undefined;
  if (HHMM.test(normalized) || markers.has(normalized)) return normalized;
  return undefined;
}

type StopMatch =
  | { kind: 'exact'; index: number; name: string }
  | { kind: 'partial'; index: number; name: string }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' };

function findStop(nodes: BusRoute['node_info'], name: string): StopMatch {
  const wanted = clean(name);
  const exact = nodes.findIndex((n) => clean(n.name) === wanted);
  if (exact !== -1) return { kind: 'exact', index: exact, name: nodes[exact].name };
  const normalized = wanted.toLowerCase();
  const partials = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => {
      const nLower = clean(n.name).toLowerCase();
      return nLower.includes(normalized) || normalized.includes(nLower);
    });
  if (partials.length === 1) return { kind: 'partial', index: partials[0].i, name: nodes[partials[0].i].name };
  if (partials.length > 1) return { kind: 'ambiguous', names: partials.map(({ n }) => n.name) };
  return { kind: 'none' };
}

/** 회차를 지정했으면 이름으로 찾고, 안 했으면 회차가 하나뿐일 때만 그걸 쓴다. */
function pickTrip<T extends { name: string }>(trips: T[], name: string | undefined): T | undefined {
  if (name) return trips.find((trip) => clean(trip.name) === clean(name));
  return trips.length === 1 ? trips[0] : undefined;
}

interface ResolvedRoute {
  semester: SemesterType;
  payload: BusPayload;
  route: BusRoute;
}

/**
 * 노선 단위 수정의 대상을 하나로 좁힌다. 못 좁히면 이유를 problems에 남긴다.
 *
 * LLM은 노선 목록({{ROUTES}})만 보고 학기 정보는 못 본다 — 원문에 학기 언급이
 * 없으면 실제로 뭐가 있는지 모른 채 "정규학기"를 찍어내는 일이 흔하다. 그래서
 * raw.semester가 실제 존재하는 학기와 맞아떨어질 때만 "사용자가 지정한 학기"로
 * 믿고 그 안에서 찾는다. 아니면 전체 학기에서 찾는다 — 노선 검색 결과가 학기를
 * 알려주지, 그 반대가 아니다.
 */
function resolveRoute(raw: RawPatch, conversions: BusConversion[], problems: string[]): ResolvedRoute | undefined {
  const explicitSemester = semesterOfTitle(raw.semester);
  const explicitMatches = explicitSemester ? conversionsBySemester(conversions, explicitSemester) : [];
  const searchSpace = explicitMatches.length > 0 ? explicitMatches : conversions;
  const hints = { region: raw.region, direction: raw.direction, route: raw.route };
  const matches = searchSpace.flatMap((conversion) => routeCandidates(conversion, hints));
  const label = routeLabel(raw);

  if (matches.length === 0) {
    problems.push(`"${label}"에 해당하는 노선을 찾지 못했습니다.`);
    return undefined;
  }

  const bySemester = new Map<SemesterType, typeof matches>();
  for (const match of matches) {
    const semesterType = match.payload.semester_type as SemesterType;
    bySemester.set(semesterType, [...(bySemester.get(semesterType) ?? []), match]);
  }
  if (bySemester.size > 1) {
    problems.push(
      `"${label}"이 여러 학기에 걸쳐 있습니다: ${[...bySemester.keys()].map((s) => TITLE_OF[s]).join(', ')}. ` +
        `학기를 지정해주세요. (예: "계절학기 ${label} ...")`,
    );
    return undefined;
  }

  const [[semester, candidates]] = bySemester;
  if (candidates.length > 1) {
    problems.push(
      `"${label}"는 여러 노선입니다: ${candidates.map((c) => describeRoute(c.route)).join(', ')}. 방향(등교/하교)까지 지정해주세요.`,
    );
    return undefined;
  }
  return { semester, payload: candidates[0].payload, route: candidates[0].route };
}

/** 문제를 알릴 때 사용자가 부른 노선 이름. 이름 없이 지역·방향만 말했으면 그걸 쓴다. */
function routeLabel(raw: RawPatch): string {
  const name = clean(raw.route);
  if (name) return name;
  const regionAndDirection = `${clean(raw.region)} ${clean(raw.direction)}`.trim();
  return regionAndDirection || '지정한';
}

/**
 * period는 노선이 아니라 학기 전체(version_update)에 대한 수정이라, 노선 검색으로
 * 학기를 되짚을 방법이 없다. 학기가 실제로 하나뿐이면 그걸로 강제하고, 그마저
 * 아니면 명시적으로 받아야 한다.
 */
function resolvePeriodPatch(raw: RawPatch, conversions: BusConversion[], problems: string[]): BusPatch | null {
  const explicitSemester = semesterOfTitle(raw.semester);
  const distinct = distinctSemesterTypes(conversions);
  // 지정한 학기가 실제로 있으면 그걸 쓰고, 없으면(LLM이 지어낸 학기일 수 있다)
  // 학기가 하나뿐일 때만 그걸 쓴다.
  const semester = [explicitSemester, distinct.length === 1 ? distinct[0] : undefined].find(
    (candidate) => candidate && conversionBySemester(conversions, candidate),
  );
  const conversion = semester ? conversionBySemester(conversions, semester) : undefined;
  if (!conversion || !semester) {
    problems.push(
      explicitSemester
        ? `"${TITLE_OF[explicitSemester]}"의 변환 결과가 없습니다.`
        : '어느 학기의 적용 기간을 바꿀지 확정할 수 없습니다. (정규학기/계절학기/방학기간을 지정해주세요)',
    );
    return null;
  }

  const after = clean(raw.value);
  if (!PERIOD.test(after)) {
    problems.push(`적용 기간 "${raw.value}"은 YYYY-MM-DD~YYYY-MM-DD 형태여야 합니다.`);
    return null;
  }
  const [start, end] = after.split('~');
  if (new Date(`${start}T00:00:00Z`) > new Date(`${end}T00:00:00Z`)) {
    problems.push(`적용 기간 "${raw.value}"의 시작이 끝보다 늦습니다.`);
    return null;
  }
  return {
    semester,
    target: 'commuting',
    region: '',
    routeType: '',
    routeName: '',
    kind: 'period',
    before: conversion.version_update.content,
    after,
    rawValue: after,
    value: after,
  };
}

/** 노선 단위 수정이 공통으로 받는 값. */
interface RouteContext extends ResolvedRoute {
  raw: RawPatch;
  problems: string[];
  /** 문제를 알릴 때 앞에 붙이는 노선 설명. */
  where: string;
  /** 패치마다 똑같이 들어가는 대상 노선 정보. */
  base: Pick<BusPatch, 'semester' | 'target' | 'region' | 'routeType' | 'routeName'>;
}

interface TripContext extends RouteContext {
  trip: BusRoute['route_info'][number];
}

type RouteResolver = (ctx: RouteContext) => BusPatch | null;

/** 이미 있는 회차를 고치는 항목. 회차를 못 찾으면 여기서 거른다. */
function withTrip(resolve: (ctx: TripContext) => BusPatch | null): RouteResolver {
  return (ctx) => {
    const trips = ctx.route.route_info;
    const trip = pickTrip(trips, ctx.raw.trip);
    if (!trip) {
      const reason = ctx.raw.trip
        ? `회차 "${clean(ctx.raw.trip)}"를 찾지 못했습니다.`
        : `회차를 지정해주세요. (가능한 회차: ${trips.map((t) => t.name).join(', ')})`;
      ctx.problems.push(`${ctx.where}: ${reason}`);
      return null;
    }
    return resolve({ ...ctx, trip });
  };
}

/** 정류장 하나를 찾는다. 없거나 여럿이면 problems에 남기고 undefined. */
function requireStop(
  { route, problems, where }: RouteContext,
  name: string,
  label = '정류장',
): { index: number; name: string } | undefined {
  const match = name ? findStop(route.node_info, name) : ({ kind: 'none' } as const);
  if (match.kind === 'none') {
    problems.push(`${where}: ${label} "${clean(name)}"를 찾지 못했습니다.`);
    return undefined;
  }
  if (match.kind === 'ambiguous') {
    problems.push(
      `${where}: ${label} "${clean(name)}"가 여러 개 일치합니다: ${match.names.join(', ')}. 정확한 이름을 적어주세요.`,
    );
    return undefined;
  }
  return match;
}

/** kind마다 해석 방법 하나. `Record`라 kind가 늘면 여기를 채우기 전엔 컴파일되지 않는다. */
const ROUTE_RESOLVERS: Record<Exclude<BusPatchKind, 'period'>, RouteResolver> = {
  route_name: ({ raw, problems, where, base, route }) => {
    const after = clean(raw.value);
    if (!after) {
      problems.push(`${where}: 바꿀 노선명을 적어주세요.`);
      return null;
    }
    return { ...base, kind: 'route_name', before: route.route_name, after, rawValue: after, value: after };
  },

  remove_route: ({ raw, problems, where, base, payload }) => {
    if (Object.values(payload.body)[0].length <= 1) {
      problems.push(`${where}: 마지막 남은 노선은 삭제할 수 없습니다.`);
      return null;
    }
    return { ...base, kind: 'remove_route', before: where, after: '삭제', rawValue: clean(raw.route) };
  },

  arrival_time: withTrip((ctx) => {
    const { raw, problems, where, base, trip } = ctx;
    const stop = requireStop(ctx, raw.stop);
    if (!stop) return null;
    const value = validateTime(raw.value);
    if (!value) {
      problems.push(`${where} ${trip.name} ${clean(raw.stop)}: "${raw.value}"은 시각(HH:MM)이나 마커가 아닙니다.`);
      return null;
    }
    return {
      ...base,
      kind: 'arrival_time',
      tripName: trip.name,
      stopName: stop.name,
      before: trip.arrival_time[stop.index] ?? '(미운행)',
      after: value,
      rawValue: value,
      value,
    };
  }),

  running_days: withTrip(({ raw, problems, where, base, trip }) => {
    const text = raw.days || raw.value;
    const days = sourceDays(text);
    if (!days) {
      problems.push(`${where} ${trip.name}: 요일 표기 "${text}"를 해석하지 못했습니다. (예: 월수금, 주중, 매일)`);
      return null;
    }
    return {
      ...base,
      kind: 'running_days',
      tripName: trip.name,
      before: daysLabel(trip.running_days),
      after: daysLabel(days),
      rawValue: text,
      days,
    };
  }),

  remove_trip: withTrip(({ raw, problems, where, base, route, trip }) => {
    if (route.route_info.length <= 1) {
      problems.push(`${where}: 마지막 남은 회차는 삭제할 수 없습니다.`);
      return null;
    }
    return {
      ...base,
      kind: 'remove_trip',
      tripName: trip.name,
      before: `${where} ${trip.name} 삭제`,
      after: '삭제',
      rawValue: clean(raw.trip),
    };
  }),

  remove_stop: (ctx) => {
    const { raw, problems, where, base, route } = ctx;
    if (route.node_info.length <= 1) {
      problems.push(`${where}: 마지막 남은 정류장은 삭제할 수 없습니다.`);
      return null;
    }
    const stop = requireStop(ctx, raw.stop);
    if (!stop) return null;
    return {
      ...base,
      kind: 'remove_stop',
      stopName: stop.name,
      before: `${where} ${stop.name} 삭제`,
      after: '삭제',
      rawValue: stop.name,
    };
  },

  add_trip: ({ raw, problems, where, base, route }) => {
    const name = clean(raw.trip);
    if (!name) {
      problems.push(`${where}: 추가할 회차 이름을 적어주세요. (예: 7회)`);
      return null;
    }
    if (route.route_info.some((t) => clean(t.name) === name)) {
      problems.push(`${where}: 회차 "${name}"이 이미 있습니다.`);
      return null;
    }
    const value = raw.value ? validateTime(raw.value) : undefined;
    if (raw.value && !value) {
      problems.push(`${where}: 추가 회차 시각 "${raw.value}"은 시각(HH:MM)이나 마커가 아닙니다.`);
      return null;
    }
    return {
      ...base,
      kind: 'add_trip',
      tripName: name,
      before: '-',
      after: value ? `${name} 추가 (첫 정류장 ${value})` : `${name} 추가`,
      rawValue: name,
      value,
    };
  },

  add_stop: (ctx) => {
    const { raw, problems, where, base, route } = ctx;
    const name = clean(raw.newStop);
    if (!name) {
      problems.push(`${where}: 추가할 정류장 이름을 적어주세요.`);
      return null;
    }
    const duplicate = findStop(route.node_info, name);
    if (duplicate.kind === 'exact' || duplicate.kind === 'partial') {
      problems.push(`${where}: 정류장 "${name}"이 이미 있습니다.`);
      return null;
    }
    if (duplicate.kind === 'ambiguous') {
      problems.push(`${where}: 정류장 "${name}"와 유사한 정류장이 여러 개 있습니다: ${duplicate.names.join(', ')}.`);
      return null;
    }
    const reference = clean(raw.referenceStop);
    if (!reference || findStop(route.node_info, reference).kind === 'none') {
      problems.push(`${where}: 정류장 "${name}"을 어디에 추가할지 지정해주세요. (기준 정류장과 앞/뒤)`);
      return null;
    }
    const anchor = requireStop(ctx, reference, '기준 정류장');
    if (!anchor) return null;
    const beforeStop = raw.position === 'before' ? anchor.name : undefined;
    const afterStop = raw.position === 'after' ? anchor.name : undefined;
    if (!beforeStop && !afterStop) {
      problems.push(`${where}: "${reference}" 기준으로 앞(before)인지 뒤(after)인지 지정해주세요.`);
      return null;
    }
    return {
      ...base,
      kind: 'add_stop',
      before: '-',
      after: `${name} 추가 (${afterStop ? `${afterStop} 뒤` : `${beforeStop} 앞`})`,
      rawValue: name,
      addStop: { name, beforeStop, afterStop },
    };
  },
};

const isRouteKind = (field: string): field is Exclude<BusPatchKind, 'period'> => field in ROUTE_RESOLVERS;

export function resolvePatch(raw: RawPatch, conversions: BusConversion[], problems: string[]): BusPatch | null {
  if (raw.field === 'period') return resolvePeriodPatch(raw, conversions, problems);

  const resolved = resolveRoute(raw, conversions, problems);
  if (!resolved) return null;

  const { semester, payload, route } = resolved;
  const where = describeRoute(route);
  if (!isRouteKind(raw.field)) {
    problems.push(`${where}: "${raw.field}"은 지원하지 않는 수정 항목입니다.`);
    return null;
  }
  return ROUTE_RESOLVERS[raw.field]({
    ...resolved,
    raw,
    problems,
    where,
    base: {
      semester,
      target: payload.target,
      region: route.region,
      routeType: route.route_type,
      routeName: route.route_name,
    },
  });
}

const TRIP_RANGE = /(\d+)\s*(?:회차?)?\s*(?:~|-|부터)\s*(\d+)\s*회차?/;

/** "1회부터 7회까지" / "1~7회" / "1회 ~ 7회까지" 같은 회차 범위 표현에서 시작·끝 번호를 뽑는다. */
function parseTripRange(text: string): [number, number] | undefined {
  const match = clean(text).match(TRIP_RANGE);
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return undefined;
  return [from, to];
}

/**
 * `resolvePatch`를 감싸서 회차 범위를 전개한다. 스키마상 patch 하나엔 회차 하나만
 * 담을 수 있어(안 그러면 LLM이 직접 여러 개로 쪼개려다 노선명에 이상한 값을
 * 채우거나 "확정할 수 없다"며 통째로 포기하는 일이 잦았다) — 범위 텍스트는
 * 그대로 두게 하고, 실제 회차 목록과의 대조·전개는 여기서 코드가 한다.
 */
export function resolvePatches(raw: RawPatch, conversions: BusConversion[], problems: string[]): BusPatch[] {
  const range = raw.trip ? parseTripRange(raw.trip) : undefined;
  if (!range) {
    const patch = resolvePatch(raw, conversions, problems);
    return patch ? [patch] : [];
  }

  const route = resolveRoute(raw, conversions, problems)?.route;
  if (!route) return [];

  const [from, to] = range;
  const tripNames = route.route_info
    .map((t) => ({ name: t.name, n: Number(clean(t.name).match(/^(\d+)회$/)?.[1]) }))
    .filter((t) => Number.isFinite(t.n) && t.n >= from && t.n <= to)
    .map((t) => t.name);

  if (tripNames.length === 0) {
    problems.push(
      `${describeRoute(route)}: ${from}회~${to}회에 해당하는 회차를 찾지 못했습니다. ` +
        `(가능한 회차: ${route.route_info.map((t) => t.name).join(', ')})`,
    );
    return [];
  }

  const resolved: BusPatch[] = [];
  for (const tripName of tripNames) {
    const patch = resolvePatch({ ...raw, trip: tripName }, conversions, problems);
    if (patch) resolved.push(patch);
  }
  return resolved;
}

/** 실제 존재하는 노선 목록을 "지역 방향 노선명" 형태로 정리한다. 중복은 제거한다. */
export function buildRouteList(conversions: BusConversion[]): string {
  // region/route_type/route_name을 공백으로만 이으면 "천안 셔틀 천안 셔틀"처럼
  // 지역명·노선명이 겹칠 때 필드 경계가 안 보여 LLM이 노선명을 잘못 되읽는다.
  // 회차 이름도 같이 안 주면 "1회부터 7회까지" 같은 범위가 진짜 있는 회차인지
  // LLM이 확인할 방법이 없어 unclear로 넘겨버린다 — 둘 다 여기서 같이 준다.
  const trips = new Map<string, Set<string>>();
  for (const conversion of conversions) {
    for (const payload of conversion.payloads) {
      const routes = Object.values(payload.body)[0] ?? [];
      for (const route of routes) {
        const key = `${route.region} | ${route.route_type} | ${route.route_name}`;
        const names = trips.get(key) ?? new Set<string>();
        for (const trip of route.route_info) names.add(trip.name);
        trips.set(key, names);
      }
    }
  }
  return [...trips.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, names]) => `${key} | 회차: ${[...names].join(', ')}`)
    .join('\n');
}

/**
 * 자연어 → 검증된 수정 계획.
 * LLM은 "무엇을 무엇으로"만 뽑고, 그게 말이 되는지는 전부 코드가 본다.
 * 시각·요일·기간은 실제로 해석해봐서 통과해야만 계획에 들어간다.
 */
export async function planBusPatches(text: string, conversions: BusConversion[], context = ''): Promise<BusPatchPlan> {
  const raw = await generateStructured<{
    patches: RawPatch[];
    unclear: string[];
  }>({
    system: SYSTEM_PROMPT.replace('{{ROUTES}}', buildRouteList(conversions)),
    schema: PATCH_SCHEMA as unknown as Record<string, unknown>,
    prompt: context
      ? `직전 대화:\n${context}\n\n지금 메시지(이것만 처리해라):\n${text}`
      : `다음 수정 요청을 구조화해줘.\n\n${text}`,
  });

  const problems = raw.unclear.map((line) => `무슨 뜻인지 확실하지 않아 넘겼습니다: ${line}`);
  const patches: BusPatch[] = [];
  for (const item of raw.patches) {
    patches.push(...resolvePatches(item, conversions, problems));
  }
  return { patches, problems };
}

function routeOf(conversion: BusConversion, patch: BusPatch): { payload: BusPayload; route: BusRoute } | null {
  for (const payload of conversion.payloads) {
    const routes = Object.values(payload.body)[0] ?? [];
    const route = routes.find(
      (candidate) =>
        clean(candidate.route_name) === clean(patch.routeName) &&
        (!patch.region || candidate.region.includes(patch.region)) &&
        (!patch.routeType || clean(candidate.route_type) === clean(patch.routeType)),
    );
    if (route) return { payload, route };
  }
  return null;
}

interface RouteTarget {
  payload: BusPayload;
  route: BusRoute;
}

interface TripTarget extends RouteTarget {
  trip: BusRoute['route_info'][number];
}

/** 노선을 찾은 다음에 적용하는 패치. */
function onRoute(apply: (patch: BusPatch, target: RouteTarget) => void) {
  return (patch: BusPatch, conversion: BusConversion) => {
    const found = routeOf(conversion, patch);
    if (!found) throw new Error(`적용 대상 노선을 찾지 못했습니다: ${patch.routeName}`);
    apply(patch, found);
  };
}

/** 노선 안에서 회차까지 찾은 다음에 적용하는 패치. */
function onTrip(apply: (patch: BusPatch, target: TripTarget) => void) {
  return onRoute((patch, found) => {
    const trip = found.route.route_info.find((candidate) => clean(candidate.name) === clean(patch.tripName));
    if (!trip) throw new Error(`적용 대상 회차를 찾지 못했습니다: ${patch.tripName}`);
    apply(patch, { ...found, trip });
  });
}

function stopIndex(route: BusRoute, stopName: string | undefined): number {
  const index = route.node_info.findIndex((node) => clean(node.name) === stopName);
  if (index === -1) throw new Error(`정류장을 찾지 못했습니다: ${stopName}`);
  return index;
}

/** kind마다 적용 방법 하나. `Record`라 kind가 늘면 여기를 채우기 전엔 컴파일되지 않는다. */
const PATCH_APPLIERS: Record<BusPatchKind, (patch: BusPatch, conversion: BusConversion) => void> = {
  period: (patch, conversion) => {
    conversion.version_update.content = patch.value!;
  },
  route_name: onRoute((patch, { route }) => {
    route.route_name = patch.value!;
  }),
  remove_route: onRoute((_, { payload, route }) => {
    const routes = Object.values(payload.body)[0];
    routes.splice(routes.indexOf(route), 1);
  }),
  remove_stop: onRoute((patch, { route }) => {
    const index = stopIndex(route, patch.stopName);
    route.node_info.splice(index, 1);
    for (const trip of route.route_info) trip.arrival_time.splice(index, 1);
  }),
  add_stop: onRoute((patch, { route }) => {
    const addStop = patch.addStop!;
    const reference = addStop.afterStop ?? addStop.beforeStop;
    const found = route.node_info.findIndex((node) => clean(node.name) === reference);
    if (found === -1) throw new Error(`정류장 위치를 찾지 못했습니다: ${addStop.name}`);
    const index = addStop.afterStop ? found + 1 : found;
    route.node_info.splice(index, 0, { name: addStop.name });
    for (const trip of route.route_info) trip.arrival_time.splice(index, 0, null);
  }),
  add_trip: onRoute((patch, { route }) => {
    const value = patch.value ?? null;
    route.route_info.push({
      name: patch.tripName!,
      arrival_time: route.node_info.map((_, index) => (index === 0 ? value : null)),
    });
  }),
  arrival_time: onTrip((patch, { route, trip }) => {
    trip.arrival_time[stopIndex(route, patch.stopName)] = patch.value!;
  }),
  running_days: onTrip((patch, { trip }) => {
    trip.running_days = patch.days;
  }),
  remove_trip: onTrip((_, { route, trip }) => {
    route.route_info.splice(route.route_info.indexOf(trip), 1);
  }),
};

function applyPatch(conversion: BusConversion, patch: BusPatch) {
  PATCH_APPLIERS[patch.kind](patch, conversion);
}

/**
 * 원본을 건드리지 않고 수정본을 새로 만든다. 미리보기와 실제 적용이 갈라지지 않게.
 * 각 패치는 적용 시점에 다시 해석하므로 앞선 패치의 이름 변경을 따라잡는다.
 */
export function applyBusPatchesToConversions(conversions: BusConversion[], patches: BusPatch[]): BusConversion[] {
  const next = structuredClone(conversions) as BusConversion[];
  for (const patch of patches) {
    const conversion = next.find((candidate) =>
      candidate.payloads.some((payload) => payload.semester_type === patch.semester),
    );
    if (!conversion) throw new Error(`적용 대상 학기를 찾지 못했습니다: ${patch.semester}`);
    applyPatch(conversion, patch);
  }
  return next;
}
