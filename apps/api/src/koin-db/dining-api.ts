import { captureError } from '@koin/telemetry/runtime';
import { parseDate } from '@api/domains/dining/protocol';
import { ApiError, errorResponse } from '@api/errors';
import { importDiningLikes, likeDining, readDinings } from '@api/koin-db/dining';
import { constantTimeEqual, requireUser, viewerId } from '@api/koin-db/identity';
import { intParam } from '@api/koin-db/spring';
import type { Bindings } from '@api/runtime';

export const DINING_LIKE_PERMIT = ['GENERAL', 'STUDENT', 'COOP', 'COUNCIL'] as const;

/** ApiError는 Java 오류 응답으로, 그 밖의 실패는 503으로 바꾼다. */
export async function respond(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    captureError(error);
    return errorResponse(new ApiError(503, 'KOIN_DB_UNAVAILABLE', '학식 조회에 실패했습니다.'));
  }
}

/** 운영 전용 Worker 내부 API: `Authorization: Bearer <KOIN_DB_BRIDGE_TOKEN>`. */
export function requireBridgeToken(request: Request, env: Bindings): void {
  const token = env.KOIN_DB_BRIDGE_TOKEN;
  if (
    !token ||
    token.length < 32 ||
    !constantTimeEqual(request.headers.get('Authorization') ?? '', `Bearer ${token}`)
  ) {
    throw new ApiError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
  }
}

/** GET /dinings. Authorization·쿠키 해석은 Java @UserId와 같다(잘못된 인증은 익명). */
export function handleDinings(request: Request, env: Bindings, url: URL): Promise<Response> {
  return respond(async () => readDinings(env, url, await viewerId(request, env)));
}

/** PATCH /dining/like, /dining/like/cancel. 인증·권한 → diningId 변환 → 좋아요 순서는 Java 인자 해석 순서다. */
export function handleDiningLike(request: Request, env: Bindings, url: URL, liked: boolean): Promise<Response> {
  return respond(async () => {
    const userId = await requireUser(request, env, DINING_LIKE_PERMIT);
    await likeDining(env, userId, intParam(url, 'diningId'), liked);
    return new Response(null, { status: 200 });
  });
}

/**
 * POST /internal/workers/dining-likes/import?from=YYYY-MM-DD&to=YYYY-MM-DD (최대 62일).
 * `Authorization: Bearer <KOIN_DB_BRIDGE_TOKEN>` 운영 전용. MySQL 좋아요를 날짜 DO로 insert-or-ignore한다.
 */
export function handleDiningImport(request: Request, env: Bindings, url: URL): Promise<Response> {
  return respond(async () => {
    requireBridgeToken(request, env);
    const from = parseDate(url.searchParams.get('from') ?? '');
    const to = parseDate(url.searchParams.get('to') ?? '');
    const result = await importDiningLikes(env, from, to);
    return Response.json(result, { status: result.ok ? 200 : 502 });
  });
}
