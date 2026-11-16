import { getTranslation, requestTranslation } from 'api/translation';
import type { TranslationResult } from 'api/translation/entity';
import { isHttpError, isKoinError } from 'interfaces/APIError';

export type TranslationOutcome<T> =
  | { kind: 'success'; data: T; sourceVersion: string }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

// 서버는 번역을 25초 안에 끝내거나 실패로 돌려준다. 첫 요청부터 진행 중 결과를 다시 조회하는 시간까지 이 안으로 묶는다.
const MAX_TOTAL_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;
// `Retry-After`가 0·음수여도 쉬지 않고 조회하지 않도록 최소 간격을 둔다
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 10;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const toOutcome = <T>(result: TranslationResult<T>): TranslationOutcome<T> => {
  if (result.status === 'SUCCESS' && result.data) {
    return { kind: 'success', data: result.data, sourceVersion: result.source_version };
  }
  if (result.status === 'UNAVAILABLE') return { kind: 'unavailable' };

  return { kind: 'failed' };
};

const errorStatus = (error: unknown): number | undefined => {
  if (isKoinError(error) || isHttpError(error)) return error.status;

  return undefined;
};

// 실패 응답도 번역 결과 형식(`status`)으로 오면 그 값을 따르고, 아니면 HTTP 상태로 판단한다
const outcomeFromError = (error: unknown): TranslationOutcome<never> => {
  const body = isHttpError(error) ? error.data : undefined;
  if (typeof body === 'object' && body !== null && 'status' in body && body.status === 'UNAVAILABLE') {
    return { kind: 'unavailable' };
  }

  return errorStatus(error) === 422 ? { kind: 'unavailable' } : { kind: 'failed' };
};

interface TranslateContentOptions {
  /** 원문 종류별 번역 요청 경로. 예: `/articles/lost-item/{id}/translations` */
  path: string;
  targetLanguage: string;
  sourceVersion: string;
  /** 원문이 바뀌었다는(409) 응답을 받으면 원문을 다시 조회하고 새 `translation_source_version`을 돌려준다 */
  refetchSourceVersion: () => Promise<string | null | undefined>;
  wait?: (ms: number) => Promise<void>;
}

/**
 * 콘텐츠 번역을 요청하고 끝날 때까지 기다린다. 예외를 던지지 않고 결과를 세 가지로 돌려준다.
 * 진행 중(`PENDING`)이면 `Retry-After`만큼 기다렸다 다시 조회하고, 원문이 바뀌었으면(409) 원문을 다시 받아 한 번 더 요청한다.
 */
export async function translateContent<T>({
  path,
  targetLanguage,
  sourceVersion,
  refetchSourceVersion,
  wait = sleep,
}: TranslateContentOptions): Promise<TranslationOutcome<T>> {
  // 409로 다시 요청해도 제한 시간은 처음 요청한 때부터 센다
  const startedAt = Date.now();
  const request = async (version: string, canRefetchSource: boolean): Promise<TranslationOutcome<T>> => {
    try {
      let result = await requestTranslation<T>(path, {
        target_language: targetLanguage,
        expected_source_version: version,
      });
      while (result.status === 'PENDING' && result.translation_id) {
        const retryAfter = Math.min(
          Math.max(result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS),
          MAX_RETRY_AFTER_SECONDS,
        );
        if (Date.now() - startedAt + retryAfter * 1000 > MAX_TOTAL_MS) return { kind: 'failed' };
        await wait(retryAfter * 1000);
        result = await getTranslation<T>(result.translation_id);
      }

      return toOutcome(result);
    } catch (error) {
      if (errorStatus(error) === 409 && canRefetchSource) {
        const nextVersion = await refetchSourceVersion().catch(() => null);
        if (nextVersion) return request(nextVersion, false);
      }

      return outcomeFromError(error);
    }
  };

  return request(sourceVersion, true);
}
