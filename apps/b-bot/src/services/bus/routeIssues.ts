import type { BusConversion, BusRoute } from './types';

/**
 * 경고 문구를 노선에 매칭한다.
 *
 * "천안 하교는 등교 노선 역순...으로 자동 계산해 추가했습니다" 같은 경고는 노선명이
 * 아닌 지역·방향 단위로 영향을 표시한다. 특정 노선을 건너뛴 경고(지역+노선명 등장)는
 * 지역+노선명 결합으로만 부분 일치해 "세종" 같은 짧은 이름이 오매칭되지 않게 한다.
 *
 * 검토 페이지(reviewHtml)와 Slack 요약(pipeline)이 서로 다른 로직으로 세면 두 숫자가
 * 어긋난다 — 노선 단위 판정은 이 함수 하나로만 한다.
 */
export function warningsForRoute(
  warnings: string[],
  route: Pick<BusRoute, 'region' | 'route_type' | 'route_name'>,
): string[] {
  return warnings.filter((warning) => {
    return (
      warning.startsWith(`${route.region} ${route.route_type}`) ||
      warning.includes(`${route.region} ${route.route_name}`)
    );
  });
}

/** 회차 중 하나라도 운행요일이 비어 있으면 미지정으로 본다. */
export function routeHasNoDays(route: BusRoute): boolean {
  return route.route_info.some((trip) => !trip.running_days?.length);
}

export interface BusRouteIssueCounts {
  /** 경고가 하나라도 매칭된 노선 수(경고 건수가 아니다 — 노선 하나가 여러 경고를,
   *  경고 하나가 여러 노선을 가리킬 수 있다). */
  issueRouteCount: number;
  /** 운행요일이 미지정인 노선 수. */
  noDaysRouteCount: number;
}

/** conversions 전체를 훑어 노선 단위 집계를 낸다. reviewHtml의 타일과 항상 같은 값이 나온다. */
export function countBusRouteIssues(conversions: BusConversion[]): BusRouteIssueCounts {
  let issueRouteCount = 0;
  let noDaysRouteCount = 0;
  for (const conversion of conversions) {
    const warnings = conversion.warnings.map((warning) =>
      typeof warning === 'string' ? warning : JSON.stringify(warning),
    );
    for (const payload of conversion.payloads) {
      for (const route of Object.values(payload.body).flat()) {
        if (warningsForRoute(warnings, route).length) issueRouteCount++;
        if (routeHasNoDays(route)) noDaysRouteCount++;
      }
    }
  }
  return { issueRouteCount, noDaysRouteCount };
}
