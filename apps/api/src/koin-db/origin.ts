import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';

/** AWS 읽기 bridge의 고정 SELECT endpoint(/internal/edge/<이름>). nginx가 bridge로 보내므로 /_koin_api 접두어를 붙이지 않는다. */
export const BRIDGE_RESOURCES = [
  'dinings',
  'dining-likes',
  'users',
  'dining-menu',
  'dining-range',
  'dining-search',
  'coop-opens',
  'dining-notification-targets',
  'user-names',
  'dining-owned',
  'dining-reports',
  'dining-report-changes',
  'dining-report-sequence',
] as const;

/** DNS-only AWS 호스트로 연결하되 원래 API Host·TLS 인증서 범위를 유지한다. */
export function fetchOrigin(request: Request, env: Bindings): Promise<Response> {
  const production = env.ENVIRONMENT === 'production';
  const api = production ? 'api.koreatech.in' : 'api.stage.koreatech.in';
  const allowed = production ? 'https://admin.koreatech.in' : 'https://api.stage.koreatech.in';
  const origin = env.KOIN_AWS_ORIGIN ?? allowed;
  if (origin !== allowed) {
    throw new ApiError(503, 'KOIN_ORIGIN_CONFIGURATION_ERROR', 'AWS 원본 연결 설정이 올바르지 않습니다.');
  }
  const url = new URL(request.url);
  const target = new URL(origin);
  const bridge = BRIDGE_RESOURCES.some((resource) => url.pathname === `/internal/edge/${resource}`);
  target.pathname = production && !bridge ? `/_koin_api${url.pathname}` : url.pathname;
  target.search = url.search;
  const forwarded = new Request(target, request);
  forwarded.headers.delete('Host');
  forwarded.headers.delete('X-Koin-Origin-Token');
  if (production) {
    if (!env.KOIN_DB_BRIDGE_TOKEN || env.KOIN_DB_BRIDGE_TOKEN.length < 32) {
      throw new ApiError(503, 'KOIN_ORIGIN_CONFIGURATION_ERROR', 'AWS 원본 인증이 설정되지 않았습니다.');
    }
    forwarded.headers.set('X-Koin-Origin-Token', env.KOIN_DB_BRIDGE_TOKEN);
  }
  forwarded.headers.delete('Forwarded');
  forwarded.headers.delete('X-Forwarded-Host');
  forwarded.headers.delete('X-Forwarded-Proto');
  forwarded.headers.delete('X-Forwarded-For');
  return fetch(new Request(forwarded, { redirect: 'manual' }));
}
