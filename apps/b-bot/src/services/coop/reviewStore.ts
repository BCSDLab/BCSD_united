import type { AdminUpdateSemesterRequest, RegularConversionResult } from './types';
import type { CoopPatch } from './patch';
import type { KoinEnv } from '~/services/koin/target';

import { createPlanStore, createReviewStore, buildReviewUrl as buildUrl } from '~/services/koin/reviewToken';

export {
  createReviewToken as createCoopReviewToken,
  isExpired as isCoopReviewExpired,
  isValidToken as isValidCoopToken,
} from '~/services/koin/reviewToken';

export function buildReviewUrl(token: string): string {
  return buildUrl('coop-review', token);
}

export interface StoredCoopReview {
  html: string;
  request: AdminUpdateSemesterRequest;
  conversion: RegularConversionResult;
  periods?: Array<{
    kind: '계절학기' | '방학';
    request: AdminUpdateSemesterRequest;
    conversion: RegularConversionResult;
  }>;
  meta: {
    env: KoinEnv;
    year: number;
    termName: string;
    sourceFileName: string;
    shopCount: number;
    blockingCount: number;
    createdAt: string;
  };
}

const store = createReviewStore<StoredCoopReview>('coop');

export const saveCoopReview = store.save;
export const updateCoopReview = store.update;
export const loadCoopReview = store.load;
export const linkCoopThread = store.linkThread;
export const findCoopTokenByThread = store.findTokenByThread;

export interface StoredCoopPatchPlan {
  reviewToken: string;
  patches: CoopPatch[];
  problems: string[];
  periodIndex?: number;
  createdAt: string;
}

const plans = createPlanStore<StoredCoopPatchPlan>('coop');

export function saveCoopPatchPlan(
  reviewToken: string,
  plan: Pick<StoredCoopPatchPlan, 'patches' | 'problems' | 'periodIndex'>,
): Promise<string> {
  return plans.save({ reviewToken, ...plan });
}

export const loadCoopPatchPlan = plans.load;
export const dropCoopPatchPlan = plans.drop;
