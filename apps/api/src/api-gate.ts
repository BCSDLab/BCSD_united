import { ApiError, errorResponse } from '@api/errors';
import type { Bindings } from '@api/runtime';

/**
 * 업무 API 실행 게이트. `API_ENABLED`가 정확히 문자열 'true'일 때만 활성이고,
 * 미설정·공백·'TRUE'·'1' 등은 전부 비활성으로 본다(기본값 비활성).
 * 비활성 상태에서는 HTTP·cron·queue·Durable Object 어느 진입점도 D1/R2/Queue 업무 IO를 수행하지 않는다.
 */
export function isApiEnabled(env: Pick<Bindings, 'API_ENABLED'>): boolean {
  return env.API_ENABLED === 'true';
}

/** 비활성 중 클라이언트가 재시도 전 기다리도록 안내하는 시간(초). */
export const API_DISABLED_RETRY_AFTER_SECONDS = 3_600;

/**
 * 비활성 중 큐 메시지를 재시도로 되돌릴 때 적용하는 지연(초).
 * ack/drop 없이 메시지를 보존하기 위해 Queues가 허용하는 최대 지연(24시간)을 쓴다.
 * 재시도 횟수는 소비자 `max_retries`에 누적되므로 장기 중단 시 원격 큐 일시정지는 별도 운영 작업이다.
 */
export const API_DISABLED_QUEUE_RETRY_DELAY_SECONDS = 86_400;

/** 비활성 응답: 503, 캐시 금지, Retry-After. 업무 코드가 실행되기 전에 반환한다. */
export function apiDisabledResponse(): Response {
  const response = errorResponse(
    new ApiError(
      503,
      'API_DISABLED',
      '이 API 서비스는 현재 비활성화되어 있습니다. 운영 중인 API 서버를 이용해 주세요.',
    ),
  );
  response.headers.set('Retry-After', String(API_DISABLED_RETRY_AFTER_SECONDS));
  return response;
}
