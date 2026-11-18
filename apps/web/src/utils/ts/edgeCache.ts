import { traceOperation } from '@koin/telemetry/runtime';

import { isHttpError, isKoinError } from 'interfaces/APIError';

// 공개 페이지 SSR 응답의 엣지 캐시(`s-maxage`) 유지 시간과 해당 loader 조회의 재시도.
// span op·속성의 `isr` 이름은 Sentry 조회 기준이므로 유지한다.
export const ARTICLE_DETAIL_EDGE_CACHE_SECONDS = 60 * 10;
export const BUS_SHUTTLE_EDGE_CACHE_SECONDS = 60 * 30;
export const ROOM_EDGE_CACHE_SECONDS = 60 * 60;

const STATIC_FETCH_RETRY_ATTEMPTS = 2;
const STATIC_FETCH_RETRY_DELAY_MS = 300;

export function isNotFoundKoinError(error: unknown): boolean {
  return isKoinError(error) && error.status === 404;
}

function isRetryableStaticFetchError(error: unknown): boolean {
  if (isKoinError(error)) {
    return error.status === 429 || error.status >= 500;
  }

  if (isHttpError(error)) {
    const { status } = error;

    return status === undefined || status === 429 || status >= 500;
  }

  return true;
}

function getStaticFetchStatus(error: unknown): number | 'network' | 'unknown' {
  if (isKoinError(error)) return error.status;

  if (isHttpError(error)) return error.status ?? 'network';

  return 'unknown';
}

export async function withStaticFetchRetry<T>(resource: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= STATIC_FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await traceOperation(
        {
          name: `ISR fetch: ${resource}`,
          op: 'koin.isr.fetch',
          onlyIfParent: true,
          attributes: {
            'isr.resource': resource,
            'retry.attempt': attempt + 1,
            'retry.max_attempts': STATIC_FETCH_RETRY_ATTEMPTS + 1,
          },
        },
        async (span) => {
          try {
            const result = await task();
            span.setAttribute('retry.result', 'success');

            return result;
          } catch (error) {
            span.setAttribute('retry.result', 'error');
            span.setAttribute('http.response.status_code', getStaticFetchStatus(error));
            throw error;
          }
        },
      );
    } catch (error) {
      if (!isRetryableStaticFetchError(error)) {
        throw error;
      }

      lastError = error;

      if (attempt === STATIC_FETCH_RETRY_ATTEMPTS) {
        break;
      }

      const delay = STATIC_FETCH_RETRY_DELAY_MS * (attempt + 1);
      await traceOperation(
        {
          name: `ISR retry wait: ${resource}`,
          op: 'koin.isr.retry_wait',
          onlyIfParent: true,
          attributes: {
            'isr.resource': resource,
            'retry.next_attempt': attempt + 2,
            'retry.delay_ms': delay,
          },
        },
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, delay);
          }),
      );
    }
  }

  throw lastError ?? new Error('Static fetch failed without an error payload.');
}
