import { getTranslation, requestTranslation } from 'api/translation';
import type { TranslationResult } from 'api/translation/entity';
import { isHttpError } from 'interfaces/APIError';
import { getErrorStatus } from 'utils/ts/httpError';

export type TranslationOutcome<T> =
  | { kind: 'success'; data: T; sourceVersion: string }
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | { kind: 'aborted' };

// 서버는 번역을 25초 안에 끝내거나 실패로 돌려준다. 첫 요청부터 진행 중 결과를 다시 조회하는 시간까지 이 안으로 묶는다.
const MAX_TOTAL_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;
// `Retry-After`가 0·음수여도 쉬지 않고 조회하지 않도록 최소 간격을 둔다
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 10;

// `signal`이 중단되면 기다리지 않고 바로 끝낸다. 중단됐는지는 호출부가 확인한다.
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();

      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const toOutcome = <T>(result: TranslationResult<T>): TranslationOutcome<T> => {
  if (result.status === 'SUCCESS' && result.data) {
    return { kind: 'success', data: result.data, sourceVersion: result.source_version };
  }
  if (result.status === 'UNAVAILABLE') return { kind: 'unavailable' };

  return { kind: 'failed' };
};

// 실패 응답도 번역 결과 형식(`status`)으로 오면 그 값을 따르고, 아니면 HTTP 상태로 판단한다
const outcomeFromError = (error: unknown): TranslationOutcome<never> => {
  const body = isHttpError(error) ? error.data : undefined;
  if (typeof body === 'object' && body !== null && 'status' in body && body.status === 'UNAVAILABLE') {
    return { kind: 'unavailable' };
  }

  return getErrorStatus(error) === 422 ? { kind: 'unavailable' } : { kind: 'failed' };
};

interface TranslateContentOptions {
  /** 원문 종류별 번역 요청 경로. 예: `/articles/lost-item/{id}/translations` */
  path: string;
  targetLanguage: string;
  sourceVersion: string;
  /** 원문이 바뀌었다는(409) 응답을 받으면 원문을 다시 조회하고 새 `translation_source_version`을 돌려준다 */
  refetchSourceVersion: () => Promise<string | null | undefined>;
  /** 중단되면 남은 요청과 대기를 멈추고 `{ kind: 'aborted' }`를 돌려준다 */
  signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  signal,
  wait = sleep,
}: TranslateContentOptions): Promise<TranslationOutcome<T>> {
  // 409로 다시 요청해도 제한 시간은 처음 요청한 때부터 센다
  const startedAt = Date.now();
  const request = async (version: string, canRefetchSource: boolean): Promise<TranslationOutcome<T>> => {
    try {
      let result = await requestTranslation<T>(
        path,
        { target_language: targetLanguage, expected_source_version: version },
        signal,
      );
      while (result.status === 'PENDING' && result.translation_id) {
        const remainingMs = MAX_TOTAL_MS - (Date.now() - startedAt);
        if (signal?.aborted) return { kind: 'aborted' };
        if (remainingMs <= 0) return { kind: 'failed' };
        const retryAfter = Math.min(
          Math.max(result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS),
          MAX_RETRY_AFTER_SECONDS,
        );
        await wait(Math.min(retryAfter * 1000, remainingMs), signal);
        if (signal?.aborted) return { kind: 'aborted' };
        result = await getTranslation<T>(result.translation_id, signal);
      }

      return toOutcome(result);
    } catch (error) {
      if (signal?.aborted) return { kind: 'aborted' };
      if (getErrorStatus(error) === 409 && canRefetchSource) {
        const nextVersion = await refetchSourceVersion().catch(() => null);
        if (signal?.aborted) return { kind: 'aborted' };
        if (nextVersion) return request(nextVersion, false);
      }

      return outcomeFromError(error);
    }
  };

  return request(sourceVersion, true);
}
