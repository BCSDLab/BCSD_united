import type { BusPatch } from './patch';
import type { KoinEnv } from '~/services/koin/target';
import type { BusConversion } from './types';

/**
 * 검토 페이지는 로그인 없이 링크만으로 열린다. 슬랙에서 바로 눌러야 하기 때문이다.
 * 대신 토큰을 추측할 수 없게 만들고 기한을 둔다.
 *
 * **이건 인증이 아니다.** 링크를 아는 사람은 누구나 볼 수 있다.
 */
export interface BusReviewMeta {
  /** 어느 코인에 반영할 건지. 검토·반영 내내 바뀌지 않아야 한다. */
  env: KoinEnv;
  sourceFileName: string;
  routeCount: number;
  /** 검토 페이지의 "확인 필요 노선"/"운행요일 미지정 노선" 타일과 항상 같은 값이어야 한다
   *  — 계산은 routeIssues.ts의 countBusRouteIssues 하나로만 한다. */
  issueRouteCount: number;
  noDaysRouteCount: number;
  createdAt: string;
}

/**
 * conversions가 원본이고 HTML은 그걸로 만든 결과다.
 * 어드민 요청도 반영할 때 conversions에서 다시 만든다 — 검토 화면과 실제로 보낼 값이
 * 갈라지지 않게 하려는 것이다.
 */
export interface StoredBusReview {
  html: string;
  conversions: BusConversion[];
  meta: BusReviewMeta;
}

import { createPlanStore, createReviewStore, buildReviewUrl as buildUrl } from '~/services/koin/reviewToken';

export {
  createReviewToken as createBusReviewToken,
  isExpired as isBusReviewExpired,
  isValidToken as isValidBusReviewToken,
} from '~/services/koin/reviewToken';

export function buildBusReviewUrl(token: string): string {
  return buildUrl('bus-review', token);
}

const store = createReviewStore<StoredBusReview>('bus');

export const saveBusReview = store.save;
export const updateBusReview = store.update;
export const loadBusReview = store.load;
export const linkBusThread = store.linkThread;
export const findBusTokenByThread = store.findTokenByThread;

export interface StoredBusPatchPlan {
  reviewToken: string;
  patches: BusPatch[];
  problems: string[];
  /** 감사 로그용으로 남기는 원래 자연어 요청. */
  request: string;
  createdAt: string;
}

const plans = createPlanStore<StoredBusPatchPlan>('bus');

export function saveBusPatchPlan(
  reviewToken: string,
  plan: Pick<StoredBusPatchPlan, 'patches' | 'problems' | 'request'>,
): Promise<string> {
  return plans.save({ reviewToken, ...plan });
}

export const loadBusPatchPlan = plans.load;
export const dropBusPatchPlan = plans.drop;
