import type { BusConversion, BusPayload, BusRoute, BusTarget, BusVersionUpdate, SemesterType } from './types';
import type { KoinAdminAuth } from '~/services/koin/adminAuth';

/** 응답이 없으면 job이 APPLYING/버전 갱신 크론이 영원히 멈춘다. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Swagger 스펙으로 고정된 Admin API 경로·body 루트 키.
 */
export const BUS_API_TARGETS: Record<BusTarget, { path: string; bodyKey: string }> = {
  commuting: {
    path: '/admin/bus/commuting/timetable',
    bodyKey: 'commuting_bus_timetables',
  },
  shuttle: {
    path: '/admin/bus/shuttle/timetable',
    bodyKey: 'shuttle_bus_timetables',
  },
};

/**
 * `A(B)` → { name: "A", detail: "B" }. 괄호가 없으면 detail은 null.
 * route_name에서 sub_name을, node_info/route_info의 name에서 detail을 뽑는다.
 */
function splitParen(text: string): { name: string; detail: string | null } {
  const match = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (match) return { name: match[1].trim(), detail: match[2].trim() };
  return { name: text, detail: null };
}

/**
 * 우리 내부 `route_type`(등교/하교/셔틀)은 검토 화면 표시와 `!수정` 매칭에 쓰는
 * 방향/종류 라벨일 뿐, KOIN Admin API의 `route_type`과는 다른 값이다. 실제 API는
 * `ShuttleRouteType`(순환/주중/주말) 세 값만 받고, commuting 엔드포인트는 그중
 * "주중"만 허용한다(`validateCommuting()`) — "등교"/"하교"/"셔틀"을 그대로 보내면
 * "버스 노선 구분이 잘못되었습니다"로 거부된다. 그래서 API로 나가는 값은 대상별로
 * 고정하고, 내부 route_type은 그대로 둔 채 전송 직전에만 바꿔친다.
 */
const WEEKEND_DAYS = new Set(['SAT', 'SUN']);

/**
 * 셔틀 노선이 토·일요일에만 운행하면 "주말", 아니면(평일 포함 순환) "순환"이다.
 * `sourceDays`(days.ts)가 "주말"/"토요일" 같은 원문을 이미 SAT/SUN으로 옮겨
 * route_info에 심어두므로, 그 결과를 다시 읽기만 하면 된다 — 별도 파서 작업이
 * 필요 없다. 요일 정보가 없는 회차만 있으면(운행요일 미기재) 평소처럼 순환으로 둔다.
 */
function shuttleRouteType(route: BusRoute): string {
  const days = route.route_info.flatMap((trip) => trip.running_days ?? []);
  return days.length > 0 && days.every((day) => WEEKEND_DAYS.has(day)) ? '주말' : '순환';
}

const adminRouteType = (route: BusRoute, target: BusTarget): string =>
  target === 'commuting' ? '주중' : shuttleRouteType(route);

/** Same stop names, either in the same order or exactly reversed; undefined if neither. */
function nodeOrderRelation(a: BusRoute['node_info'], b: BusRoute['node_info']): 'same' | 'reversed' | undefined {
  if (a.length !== b.length || a.length === 0) return undefined;
  if (a.every((node, index) => node.name === b[index].name)) return 'same';
  if (a.every((node, index) => node.name === b[a.length - 1 - index].name)) return 'reversed';
  return undefined;
}

/**
 * 이름이 달라도 같은 물리적 정류장인 경우(예: 서울 하교 종점 "교대"는 등교
 * 출발점 "3호선 교대역 14번 출구(메가커피앞)"와 같은 곳이다 — 확인됨).
 * 정류장 이름만 보고는 기계적으로 판단할 수 없어 알려진 짝만 표로 둔다.
 * 이 시점(제출 직전 병합)의 node_info.name은 아직 `splitParen` 전 원문
 * 그대로라 괄호까지 포함된 값으로 등록해 둔다. 동일성 판단에만 쓰고, 실제
 * 표시 이름은 먼저 등장한(=등교 쪽) 원문 그대로 남긴다.
 */
const NODE_NAME_ALIASES: Record<string, string> = {
  교대: '3호선 교대역 14번 출구(메가커피앞)',
};
const nodeMergeKey = (name: string) => NODE_NAME_ALIASES[name] ?? name;

/**
 * 정류장을 일부만 공유하는 두 노선을 합칠 때, 자동으로 만든 순서(먼저 등장한
 * 쪽 전부 나열 후 남은 쪽 이어붙이기)가 실제 노선과 다른 경우가 있다(예: 서울
 * 교대역 — 남부터미널은 실제로 교대와 죽전 사이에 있는데, 자동 순서는 맨
 * 뒤로 보낸다). 확인된 노선만 정확한 순서를 명시해 둔다. route_name은 요일
 * 괄호가 붙은 채로 들어오므로 그 앞부분만 비교한다.
 */
const KNOWN_NODE_ORDER: Record<string, string[]> = {
  '서울 교대역': [
    '3호선 교대역 14번 출구(메가커피앞)',
    '남부터미널',
    '동천역 환승정류장',
    '죽전 정류장(간이)',
    '신갈 정류장(간이)',
    '대학',
  ],
};

function orderedByKnownRoute(names: string[], routeName: string): string[] {
  const base = routeName.replace(/\s*\([^)]*\)\s*$/, '');
  const known = KNOWN_NODE_ORDER[base];
  if (!known) return names;
  const ordered = known
    .map((knownName) => names.find((name) => nodeMergeKey(name) === nodeMergeKey(knownName)))
    .filter((name): name is string => name !== undefined);
  const leftover = names.filter((name) => !ordered.includes(name));
  return [...ordered, ...leftover];
}

/**
 * 등교/하교가 정류장을 일부만 공유하는 경우(예: 서울 교대역 — 등교는
 * 동천역·신갈을 거치고 하교는 대신 남부터미널에서 내린다) 정류장 목록을
 * 합집합으로 만들고, 각 회차는 자신이 실제로 서는 자리에만 시간을 채우고
 * 나머지는 null로 둔다. 프로덕션 실제 데이터(`_id: 69a5a710...` "서울
 * 교대역")가 이 방식으로 등교/하교를 한 문서에 담고 있었다(다만 그 문서는
 * 정류장 자리를 손으로 재활용해 "남부터미널 하차" 같은 설명 문구를 시간
 * 자리에 넣었는데, 우리는 그 대신 정류장을 실제로 다 나열하고 null로 비운다).
 * 정류장을 하나도 공유하지 않으면(진짜 무관한 노선) 합치지 않는다.
 */
function unionMergeNodes(a: BusRoute, b: BusRoute): BusRoute | undefined {
  const shared = a.node_info.some((nodeA) =>
    b.node_info.some((nodeB) => nodeMergeKey(nodeB.name) === nodeMergeKey(nodeA.name)),
  );
  if (!shared) return undefined;
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const route of [a, b])
    for (const node of route.node_info) {
      const key = nodeMergeKey(node.name);
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(node.name);
      }
    }
  const names = orderedByKnownRoute(collected, a.route_name);
  const remap = (route: BusRoute) => {
    const indexByKey = new Map(route.node_info.map((node, index) => [nodeMergeKey(node.name), index]));
    return route.route_info.map((trip) => ({
      ...trip,
      arrival_time: names.map((name) => {
        const index = indexByKey.get(nodeMergeKey(name));
        return index === undefined ? null : trip.arrival_time[index];
      }),
    }));
  };
  return {
    ...a,
    node_info: names.map((name) => ({ name })),
    route_info: [...remap(a), ...remap(b)],
  };
}

/**
 * KOIN Admin API의 commuting upsert 키는 (region, route_type, route_name,
 * sub_name)인데, commuting route_type은 방향과 무관하게 항상 "주중"으로
 * 고정해서 보낸다(`adminRouteType`). 그래서 같은 region+route_name의 등교와
 * 하교를 별도 문서 두 개로 PUT하면 키가 완전히 같아져, 나중에 보낸 쪽이
 * 먼저 것을 덮어쓴다(DB에 하교만 남는 이유). 정류장 순서가 같거나(등교 노선
 * 역순 자동계산) 정확히 반대(원본에 별도 하교 표가 있는 경우)면 한 문서의
 * route_info 배열로 합쳐서 이 충돌을 피한다. 순서가 안 맞아도 정류장을 일부
 * 공유하면 합집합으로 합친다(unionMergeNodes). 정류장을 하나도 공유하지
 * 않으면(무관한 노선) 합치지 않는다.
 */
function mergeCommutingDirections(routes: BusRoute[]): BusRoute[] {
  const merged: BusRoute[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < routes.length; index += 1) {
    if (consumed.has(index)) continue;
    let current = routes[index];
    for (let other = index + 1; other < routes.length; other += 1) {
      if (consumed.has(other)) continue;
      const candidate = routes[other];
      if (candidate.region !== current.region || candidate.route_name !== current.route_name) continue;
      const relation = nodeOrderRelation(current.node_info, candidate.node_info);
      if (relation) {
        const candidateRouteInfo =
          relation === 'same'
            ? candidate.route_info
            : candidate.route_info.map((trip) => ({
                ...trip,
                arrival_time: [...trip.arrival_time].reverse(),
              }));
        current = { ...current, route_info: [...current.route_info, ...candidateRouteInfo] };
        consumed.add(other);
        continue;
      }
      const unioned = unionMergeNodes(current, candidate);
      if (!unioned) continue;
      current = unioned;
      consumed.add(other);
    }
    merged.push(current);
  }
  return merged;
}

/**
 * `/bus/route`(가장 빠른 교통편)의 `ShuttleBusRouteStrategy`는 정류장 이름에
 * `BusStation.KOREATECH.queryName`("한기대")이 부분 문자열로 포함되는지로
 * 캠퍼스 정류장을 찾는다. 공지문에는 이 정류장이 "대학"으로 나오지만
 * "대학".includes("한기대")는 항상 false라 셔틀 노선이 이 조회에서 전부
 * 빠진다. 자동화 이전 프로덕션 문서(`_id: 6a464b71...` "천안 계절학기 순환
 * 셔틀")도 이 정류장을 "한기대"로 표기했었다 — 그 표기를 셔틀에서만 복원한다.
 * commuting은 이 조회 대상이 아니라서(BusRouteType에 COMMUTING이 없다)
 * 영향이 없어 "대학"을 그대로 둔다.
 */
const isCampusNode = (name: string) => splitParen(name).name === '대학';

/**
 * Admin API가 정의한 필드만 남긴다. route_name과 정류장/회차 이름에서 괄호 안
 * 내용을 분리해 sub_name/detail로 보낸다. running_days는 shuttle 요청에만
 * 존재하는 필드다(KOIN_API_V2 #2397). commuting은 서버가 "주중"으로 자체
 * 도출하도록 고쳐져(#2399) 클라이언트가 보낼 필드 자체가 없으므로 붙이지
 * 않는다.
 */
const toAdminRoute = (route: BusRoute, target: BusTarget) => {
  const { name: routeName, detail: subName } = splitParen(route.route_name);
  return {
    region: route.region,
    route_type: adminRouteType(route, target),
    route_name: routeName,
    sub_name: subName,
    node_info: route.node_info.map((node) =>
      target === 'shuttle' && isCampusNode(node.name) ? { name: '한기대', detail: null } : splitParen(node.name),
    ),
    route_info: route.route_info.map((trip) => ({
      ...splitParen(trip.name),
      arrival_time: trip.arrival_time,
      ...(target === 'shuttle' && trip.running_days ? { running_days: trip.running_days } : {}),
    })),
  };
};

/**
 * 어드민 API 호출 실패.
 *
 * **어느 호출에서 났는지를 들고 다닌다.** commuting과 shuttle은 별도 API라
 * 어느 쪽에서 멈췄는지가 재시도 판단에 필요하다.
 */
export class BusAdminApiError extends Error {
  constructor(
    message: string,
    readonly stage: BusTarget,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BusAdminApiError';
  }
}

/**
 * 실제 반영. 인증은 이 모듈이 갖지 않는다 — 토큰 발급 방식이 바뀌어도 여기는
 * 그대로 두려는 것이다.
 *
 * PUT은 payload(대상 × 학기)마다 따로 나간다. 중간에 실패하면 앞선 PUT은 이미
 * 반영된 상태로 남는다 — `onApplied`로 어디까지 갔는지 호출자에게 알려준다.
 *
 * **주의: 이 PUT은 upsert다, 전체 교체가 아니다.** 새 payload에 없는 옛 노선은
 * 지워지지 않고 그대로 남는다(삭제/조회 API가 없어 여기서 정리할 방법도 없다).
 * 노선 이름·구성이 바뀌는 반영(오늘 같은 파서 수정 이후 재반영 등) 뒤에는 옛
 * 이름의 고아 노선이 없는지 사람이 직접 확인해야 한다.
 */
export async function submitBusTimetables(
  conversions: BusConversion[],
  { baseUrl, accessToken }: KoinAdminAuth,
  onApplied?: (applied: { target: BusTarget; semesterType: SemesterType }) => void,
): Promise<void> {
  const base = baseUrl.replace(/\/$/, '');
  for (const payload of conversions.flatMap((conversion: BusConversion) => conversion.payloads) as BusPayload[]) {
    const target = BUS_API_TARGETS[payload.target];
    const bodyKeys = Object.keys(payload.body);
    if (bodyKeys.length !== 1 || bodyKeys[0] !== target.bodyKey) {
      throw new BusAdminApiError(`${payload.target} Admin API body_key configuration mismatch`, payload.target, 0);
    }
    const url = new URL(base + target.path);
    url.searchParams.set('semester_type', payload.semester_type);
    const routes = Object.values(payload.body)[0];
    const submittedRoutes = payload.target === 'commuting' ? mergeCommutingDirections(routes) : routes;
    const response = await fetch(url, {
      method: 'PUT',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        [target.bodyKey]: submittedRoutes.map((route) => toAdminRoute(route, payload.target)),
      }),
    });
    if (!response.ok) {
      const detail = await response
        .text()
        .then((text) => text.slice(0, 300))
        .catch(() => '');
      throw new BusAdminApiError(
        `${payload.target} Admin API failed: ${response.status}${detail ? `\n${detail}` : ''}`,
        payload.target,
        response.status,
      );
    }
    onApplied?.({ target: payload.target, semesterType: payload.semester_type });
  }
}

/**
 * 사이트에 노출되는 "버전" 문구만 갱신한다. 시간표 반영(PUT)과는 별개 API(POST)라
 * 현재 version 값을 먼저 읽어와야 한다 — 버전 API는 title/content만 바꿔도
 * version 필드를 함께 요구한다.
 */
export async function updateBusVersionViaAdminApi(
  versionUpdate: BusVersionUpdate,
  { baseUrl, accessToken }: KoinAdminAuth,
): Promise<void> {
  const versionUrl = new URL(`/admin/version/${versionUpdate.type}`, baseUrl).toString();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const currentResponse = await fetch(versionUrl, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!currentResponse.ok) {
    throw new Error(`Version Admin API GET failed: ${currentResponse.status}`);
  }
  const current = (await currentResponse.json()) as { version?: unknown };
  if (typeof current.version !== 'string' || !current.version) {
    throw new Error('Version Admin API GET response does not contain version');
  }

  const updateResponse = await fetch(versionUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
    body: JSON.stringify({
      version: current.version,
      title: versionUpdate.title,
      content: versionUpdate.content,
    }),
  });
  if (!updateResponse.ok) {
    throw new Error(`Version Admin API POST failed: ${updateResponse.status}`);
  }
}
