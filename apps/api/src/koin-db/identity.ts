import { z } from 'zod';
import { ApiError } from '@api/errors';
import { fetchBridge, invalidBridgeResponse } from '@api/koin-db/bridge';
import { appTokenUserId, TokenError, webTokenClaims } from '@api/koin-db/jwt';
import { fetchOrigin } from '@api/koin-db/origin';
import type { Bindings } from '@api/runtime';

type UserType = 'GENERAL' | 'STUDENT' | 'COUNCIL' | 'COOP' | 'OWNER' | 'ADMIN';
const userStatus = z
  .object({
    id: z.number().int(),
    user_type: z.enum(['GENERAL', 'STUDENT', 'COUNCIL', 'COOP', 'OWNER', 'ADMIN']),
    is_deleted: z.boolean(),
    is_authed: z.boolean(),
  })
  .strict();
type UserStatus = z.infer<typeof userStatus>;
const sessionResponse = z.object({ authenticated: z.boolean(), csrf_token: z.string().nullable().optional() });

// Java ApiResponseCode/AuthenticationException 응답.
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
// User.ensureAuthed: 미인증 회원 유형별 403.
const unauthed: Record<UserType, [string, string]> = {
  OWNER: ['FORBIDDEN_OWNER', '관리자 인증 대기중입니다.'],
  STUDENT: ['FORBIDDEN_STUDENT', '아우누리에서 인증메일을 확인해주세요.'],
  ADMIN: ['FORBIDDEN_ADMIN', 'PL 인증 대기중입니다.'],
  GENERAL: ['FORBIDDEN_ACCOUNT', '유효하지 않은 계정입니다.'],
  COUNCIL: ['FORBIDDEN_ACCOUNT', '유효하지 않은 계정입니다.'],
  COOP: ['FORBIDDEN_ACCOUNT', '유효하지 않은 계정입니다.'],
};
// WebAuthProperties.accessCookieName(): secure + 공유 도메인 → __Secure-<prefix>-access (운영 koin-web, stage koin-stage-web).
const accessCookieName = (env: Bindings) =>
  env.ENVIRONMENT === 'production' ? '__Secure-koin-web-access' : '__Secure-koin-stage-web-access';

const USER_CACHE_TTL_MS = 30_000;
const USER_CACHE_LIMIT = 5_000;
const userCache = new Map<number, { status: UserStatus | null; expires: number }>();

function jwtSecret(env: Bindings): string {
  if (!env.KOIN_JWT_SECRET) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '인증 설정이 올바르지 않습니다.');
  return env.KOIN_JWT_SECRET;
}

/** ExtractAuthenticationInterceptor: 정확히 "Bearer "로 시작하는 값만 토큰이다. */
function bearerToken(request: Request): string | null {
  const value = request.headers.get('Authorization');
  return value && value.trim() && value.startsWith('Bearer ') ? value.slice(7) : null;
}

/** WebAuthProperties.accessCookieName(). 같은 이름이 두 번이면 Java처럼 인증 실패다. */
function accessCookie(request: Request, env: Bindings): string | null | 'DUPLICATE' {
  const name = accessCookieName(env);
  let found: string | null = null;
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    if (found !== null) return 'DUPLICATE';
    found = part.slice(index + 1).trim();
  }
  return found;
}

/**
 * 웹 쿠키 세션 확인은 Java에 맡긴다. 세션·CSRF 원본은 Java Redis에만 있으므로 GET /v2/web/auth/session에
 * access 쿠키와 요청 Origin/Referer만 넘겨 출처 검증·세션 만료/로그아웃·회원 존재를 Java가 판정하고,
 * 돌려받은 세션 CSRF 토큰을 X-CSRF-Token과 비교한다(WebCsrfTokenProvider.validate와 같은 결과).
 */
async function javaWebSession(request: Request, env: Bindings, token: string): Promise<string | null> {
  const headers = new Headers({ Accept: 'application/json', Cookie: `${accessCookieName(env)}=${token}` });
  for (const name of ['Origin', 'Referer']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let response: Response;
  try {
    response = await fetchOrigin(
      new Request(new URL('/v2/web/auth/session', request.url), { method: 'GET', headers, redirect: 'manual' }),
      env,
    );
  } catch {
    throw new ApiError(502, 'KOIN_UPSTREAM_UNAVAILABLE', 'API 연결에 실패했습니다.');
  }
  if (response.status === 403) throw new ApiError(403, 'FORBIDDEN_WEB_ORIGIN', '허용되지 않은 웹 요청입니다.');
  if (!response.ok) throw new ApiError(502, 'KOIN_UPSTREAM_UNAVAILABLE', 'API 연결에 실패했습니다.');
  const parsed = sessionResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiError(502, 'KOIN_UPSTREAM_UNAVAILABLE', 'API 연결에 실패했습니다.');
  return parsed.data.authenticated && parsed.data.csrf_token ? parsed.data.csrf_token : null;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/**
 * Java 인증 단계(ExtractAuthentication → WebCookieAuthentication 인터셉터)를 따라 사용자 ID를 얻는다.
 * Authorization 헤더가 있으면 쿠키를 보지 않는다. `required`가 아니면(@UserId) 인증 실패는 익명(null)이다.
 */
async function authenticate(request: Request, env: Bindings, required: boolean): Promise<number | null> {
  const optional = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      if (required) throw unauthorized();
      return null;
    }
  };
  if (request.headers.has('Authorization')) {
    const token = bearerToken(request);
    if (token === null) return null;
    return optional(() => appTokenUserId(jwtSecret(env), token));
  }
  const cookie = accessCookie(request, env);
  if (cookie === null) return null;
  return optional(async () => {
    if (cookie === 'DUPLICATE') throw new TokenError('duplicate cookie');
    const claims = await webTokenClaims(jwtSecret(env), cookie);
    const csrf = await javaWebSession(request, env, cookie);
    if (csrf === null) throw new TokenError('session');
    // WebAuthRequestValidator: 안전하지 않은 메서드만 CSRF를 본다. 실패는 @UserId에서도 무시하지 않는다.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const header = request.headers.get('X-CSRF-Token');
      if (header === null || !constantTimeEqual(header, csrf)) {
        throw new ApiError(403, 'INVALID_CSRF_TOKEN', '올바르지 않은 CSRF 토큰입니다.');
      }
    }
    return claims.userId;
  });
}

/** `@UserId` 조회: 실패한 인증은 익명이다(웹 쿠키 출처 위반 403만 그대로 전달). */
export function viewerId(request: Request, env: Bindings): Promise<number | null> {
  return authenticate(request, env, false);
}

async function loadUserStatus(env: Bindings, id: number): Promise<UserStatus | null> {
  const now = Date.now();
  const cached = userCache.get(id);
  if (cached && cached.expires > now) return cached.status;
  const body = await fetchBridge(env, 'users', { id: String(id) }, true);
  const parsed = body === null ? null : userStatus.safeParse(body);
  if (parsed && (!parsed.success || parsed.data.id !== id)) throw invalidBridgeResponse();
  const status = parsed?.data ?? null;
  userCache.delete(id);
  if (userCache.size >= USER_CACHE_LIMIT) userCache.delete(userCache.keys().next().value!);
  userCache.set(id, { status, expires: now + USER_CACHE_TTL_MS });
  return status;
}

/**
 * `@Auth(permit = ...)`: AuthArgumentResolver + User.authorizeAndGetId. User 엔티티는 @Where(is_deleted=0)이므로
 * 탈퇴 회원은 "없는 회원"(401 UNAUTHORIZED_USER)이다. 회원 상태는 bridge에서 30초 캐시한다.
 */
export async function requireUser(request: Request, env: Bindings, permit: readonly UserType[]): Promise<number> {
  const id = await authenticate(request, env, true);
  if (id === null) throw unauthorized();
  const status = await loadUserStatus(env, id);
  if (!status || status.is_deleted) throw unauthorized();
  if (!permit.includes(status.user_type))
    throw new ApiError(403, 'FORBIDDEN_USER_TYPE', '인가되지 않은 유저 타입입니다.');
  if (!status.is_authed) throw new ApiError(403, ...unauthed[status.user_type]);
  return id;
}

export function clearUserStatusCache(): void {
  userCache.clear();
}
