import type { Patch, TimeAmbiguity } from './patch';
import type { KoinEnv } from '~/services/koin/target';
import type { Lecture, TimeFormat } from './types';
import { createPlanStore, createReviewStore, buildReviewUrl as buildUrl } from '~/services/koin/reviewToken';

export { createReviewToken, isExpired, isValidToken } from '~/services/koin/reviewToken';

export interface ReviewMeta {
  /** 어느 코인에 반영할 건지. 검토·반영 내내 바뀌지 않아야 한다. */
  env: KoinEnv;
  year: number;
  termName: string;
  sourceFileName: string;
  lectureCount: number;
  issueCount: number;
  createdAt: string;
}

/**
 * 강의 목록이 원본이고 HTML은 그걸로 만든 결과다.
 * 어드민 요청도 반영할 때 목록에서 다시 만든다 — 검토 화면과 실제로 보낼 값이
 * 갈라지지 않게 하려는 것이다.
 */
export interface StoredReview {
  html: string;
  lectures: Lecture[];
  /** 수정 요청의 강의시간을 어떤 규칙으로 읽을지. 파일마다 다르다. */
  timeFormat: TimeFormat;
  meta: ReviewMeta;
}

export function buildReviewUrl(token: string): string {
  return buildUrl('review', token);
}

const store = createReviewStore<StoredReview>('lecture');

export const saveReview = store.save;
export const updateReview = store.update;
export const loadReview = store.load;
export const linkThread = store.linkThread;
export const findTokenByThread = store.findTokenByThread;

export interface StoredPatchPlan {
  reviewToken: string;
  patches: Patch[];
  ambiguities: TimeAmbiguity[];
  problems: string[];
  createdAt: string;
}

const plans = createPlanStore<StoredPatchPlan>('lecture');

export function savePatchPlan(
  reviewToken: string,
  plan: Pick<StoredPatchPlan, 'patches' | 'ambiguities' | 'problems'>,
): Promise<string> {
  return plans.save({ reviewToken, ...plan });
}

export const loadPatchPlan = plans.load;
export const dropPatchPlan = plans.drop;
