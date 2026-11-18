import { ApiError } from '@api/errors';
import { BRIDGE_RESOURCES, fetchOrigin } from '@api/koin-db/origin';
import type { Bindings } from '@api/runtime';

export type BridgeResource = (typeof BRIDGE_RESOURCES)[number];

const unavailable = 'KOIN DB 조회에 실패했습니다.';

/**
 * AWS 읽기 bridge의 고정 SELECT endpoint를 호출한다. 404는 `allowNotFound`일 때만 null이다.
 * 토큰을 요청·쿼리로 지정한 호스트에 전달하지 않는다. 환경별 승인된 HTTPS endpoint만 허용한다.
 */
export async function fetchBridge(
  env: Bindings,
  resource: BridgeResource,
  query: Record<string, string>,
  allowNotFound = false,
): Promise<unknown> {
  const base = `${
    env.ENVIRONMENT === 'production' ? 'https://api.koreatech.in' : 'https://api.stage.koreatech.in'
  }/internal/edge`;
  // KOIN_DB_BRIDGE_URL은 기존 식단 endpoint 고정값이다. 다른 값이면 어떤 bridge도 호출하지 않는다.
  if (
    (env.KOIN_DB_BRIDGE_URL !== undefined && env.KOIN_DB_BRIDGE_URL !== `${base}/dinings`) ||
    !env.KOIN_DB_BRIDGE_TOKEN ||
    env.KOIN_DB_BRIDGE_TOKEN.length < 32 ||
    /[\r\n]/.test(env.KOIN_DB_BRIDGE_TOKEN)
  ) {
    throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', 'KOIN DB 조회 연결이 설정되지 않았습니다.');
  }
  const upstream = new URL(`${base}/${resource}`);
  for (const [name, value] of Object.entries(query)) upstream.searchParams.set(name, value);
  let response: Response;
  try {
    response = await fetchOrigin(
      new Request(upstream, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.KOIN_DB_BRIDGE_TOKEN}`, Accept: 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
      }),
      env,
    );
  } catch {
    throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', unavailable);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new ApiError(503, 'KOIN_DB_UNAVAILABLE', unavailable);
  try {
    return await response.json();
  } catch {
    throw invalidBridgeResponse();
  }
}

/** bridge 응답이 고정 스키마와 다를 때. 내용은 노출하지 않는다. */
export function invalidBridgeResponse(): ApiError {
  return new ApiError(502, 'KOIN_DB_BRIDGE_INVALID_RESPONSE', 'KOIN DB 조회 응답이 올바르지 않습니다.');
}
