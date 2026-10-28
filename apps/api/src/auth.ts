import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { createDatabase } from '@api/db/client';
import { schema } from '@api/db/schema';
import { usesCookieAuthentication } from '@api/domains/identity/auth-policy';
import { fail } from '@api/domains/identity/errors';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings, Principal } from '@api/runtime';

const encoder = new TextEncoder();
const roles: Record<string, true> = { GENERAL: true, STUDENT: true, COUNCIL: true, OWNER: true, ADMIN: true, COOP: true };
const authenticationState = new WeakMap<object, { authed: boolean; error?: ApiError }>();
export type WebSession = typeof schema.identity_web_sessions.$inferSelect;

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string | null | undefined): boolean {
  if (b === null || b === undefined) return false;
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ (right[i] ?? 0);
  return difference === 0;
}

function signingConfiguration(env: Bindings) {
  if (!env.JWT_SECRET) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', 'JWT 서명 키가 설정되지 않았습니다.');
  // Java는 비밀키를 Base64로 인코딩한 문자열 자체를 HMAC 키로 사용한다.
  const key = encoder.encode(btoa(String.fromCharCode(...encoder.encode(env.JWT_SECRET))));
  if (key.length < 32) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', 'JWT 서명 키가 너무 짧습니다.');
  const bits = key.length >= 64 ? 512 : key.length >= 48 ? 384 : 256;
  return { key, algorithm: `HS${bits}`, hash: `SHA-${bits}` };
}

export async function signJwt(env: Bindings, id: number, sessionId?: string, expiresAtMs?: number): Promise<string> {
  const config = signingConfiguration(env);
  const nativeTtl = Number(env.NATIVE_ACCESS_TTL_SECONDS);
  if (expiresAtMs === undefined && (!Number.isFinite(nativeTtl) || nativeTtl < 1)) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '앱 액세스 토큰 유지 시간이 설정되지 않았습니다.');
  const expiresAt = expiresAtMs ?? Date.now() + nativeTtl * 1000;
  const header = base64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: config.algorithm })));
  const payload = base64Url(encoder.encode(JSON.stringify({ id, ...(sessionId ? { web_session_id: sessionId } : {}), exp: Math.floor(expiresAt / 1000) })));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey('raw', config.key, { name: 'HMAC', hash: config.hash }, false, ['sign']);
  return `${data}.${base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))))}`;
}

export async function verifyJwt(env: Bindings, token: string, web = false): Promise<{ id: number; web_session_id?: string; exp: number }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail('UNAUTHORIZED_USER');
    const decode = (part: string) => Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]!))) as { alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1]!))) as { id?: unknown; exp?: unknown; web_session_id?: unknown };
    const config = signingConfiguration(env);
    if (header.alg !== config.algorithm || !Number.isInteger(payload.id) || (payload.id as number) < 0 || !Number.isInteger(payload.exp) || (payload.exp as number) <= Date.now() / 1000) fail('UNAUTHORIZED_USER');
    if (web ? typeof payload.web_session_id !== 'string' || !payload.web_session_id.trim() : 'web_session_id' in payload) fail('UNAUTHORIZED_USER');
    const key = await crypto.subtle.importKey('raw', config.key, { name: 'HMAC', hash: config.hash }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decode(parts[2]!), encoder.encode(`${parts[0]}.${parts[1]}`))) fail('UNAUTHORIZED_USER');
    return payload as { id: number; web_session_id?: string; exp: number };
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) throw error;
    fail('UNAUTHORIZED_USER');
  }
}

export function webConfiguration(env: Bindings) {
  const secure = env.WEB_COOKIE_SECURE !== 'false';
  const domain = env.WEB_COOKIE_DOMAIN?.trim().toLowerCase().replace(/^\./, '') || undefined;
  const prefix = env.WEB_COOKIE_PREFIX ?? 'koin-web';
  const sameSite = env.WEB_COOKIE_SAME_SITE ?? 'Lax';
  const accessTtl = Number(env.WEB_ACCESS_TTL_SECONDS ?? 900);
  const refreshTtl = Number(env.WEB_REFRESH_TTL_SECONDS ?? 7776000);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(prefix) || !['Lax', 'Strict', 'None'].includes(sameSite) || (sameSite === 'None' && !secure)
    || !Number.isFinite(accessTtl) || accessTtl < 1 || !Number.isFinite(refreshTtl) || refreshTtl < accessTtl
    || (domain && (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)))) {
    throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '웹 인증 설정이 올바르지 않습니다.');
  }
  const sharedPrefix = secure ? domain ? '__Secure-' : '__Host-' : '';
  return { secure, domain, sameSite, accessTtl, refreshTtl, accessName: `${sharedPrefix}${prefix}-access`, refreshName: `${secure ? '__Secure-' : ''}${prefix}-refresh`, csrfName: `${sharedPrefix}${prefix}-csrf` };
}

export function readAuthCookie(c: Context<ApiEnv>, name: string): string | undefined {
  const values = (c.req.header('Cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.slice(0, value.indexOf('=')) === name);
  if (values.length > 1) fail('UNAUTHORIZED_USER');
  return values[0]?.slice(name.length + 1);
}

export function requireTrustedOrigin(c: Context<ApiEnv>): void {
  let origin = c.req.header('Origin');
  if (origin === undefined) {
    try {
      const value = c.req.header('Referer') ?? '';
      const referer = new URL(value);
      const authority = /^(https?):\/\/([^/?#\s]+)/.exec(value);
      if (authority && !/\s/.test(value) && !referer.username && !referer.password && referer.hostname) origin = `${authority[1]}://${authority[2]}`;
    } catch { origin = undefined; }
  }
  const configured = c.env.AUTH_ALLOWED_ORIGINS;
  if (!configured) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '허용된 웹 출처가 설정되지 않았습니다.');
  const allowed: unknown = configured.trim().startsWith('[') ? JSON.parse(configured) : configured.split(',').map(item => item.trim());
  if (!Array.isArray(allowed) || !origin || origin === 'null' || origin === '*' || !allowed.includes(origin)) fail('FORBIDDEN_WEB_ORIGIN');
}

async function csrfSignature(env: Bindings, sessionId: string, nonce: string): Promise<string> {
  const secret = env.WEB_CSRF_SECRET;
  if (!secret?.trim() || encoder.encode(secret).length < 32) throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '웹 CSRF 서명 키는 32바이트 이상이어야 합니다.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = `koin-web-csrf:v1!${sessionId.length}!${sessionId}!${nonce.length}!${nonce}`;
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

export async function createCsrf(env: Bindings, sessionId: string): Promise<string> {
  const nonce = randomSecret();
  return `${nonce}.${await csrfSignature(env, sessionId, nonce)}`;
}

export async function requireCsrf(env: Bindings, session: WebSession, token: string | undefined): Promise<void> {
  if (!token || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) fail('INVALID_CSRF_TOKEN');
  if (!constantTimeEqual(await csrfSignature(env, session.id, token.slice(0, 43)), token.slice(44)) || !constantTimeEqual(session.csrf_token, token)) fail('INVALID_CSRF_TOKEN');
}

export function parseRefresh(value: string | undefined): { id: string; value: string } {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(value)) fail('UNAUTHORIZED_USER');
  return { id: value.slice(0, 36), value };
}

export async function sessionFromAccess(c: Context<ApiEnv>, token: string): Promise<WebSession> {
  const claims = await verifyJwt(c.env, token, true);
  const [session] = await c.get('db').select().from(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, claims.web_session_id!), gt(schema.identity_web_sessions.expires_at, Date.now()))).limit(1);
  if (!session || session.user_id !== claims.id) fail('UNAUTHORIZED_USER');
  return session;
}

export async function authenticateToken(env: Bindings, token: string): Promise<Principal> {
  const claims = await verifyJwt(env, token);
  const [user] = await createDatabase(env.DB).select().from(schema.users).where(and(eq(schema.users.id, claims.id), eq(schema.users.is_deleted, false))).limit(1);
  if (!user || !roles[user.user_type]) fail('UNAUTHORIZED_USER');
  return { id: user.id, userType: user.user_type as Principal['userType'] };
}

export async function authenticate(c: Context<ApiEnv>): Promise<Principal | null> {
  if (c.req.method === 'OPTIONS' || c.req.path.startsWith('/v2/web/auth/')) return null;
  try {
    const authorization = c.req.header('Authorization');
    let id: number;
    let sessionId: string | undefined;
    if (authorization !== undefined) {
      if (!authorization.startsWith('Bearer ')) return null;
      id = (await verifyJwt(c.env, authorization.slice(7))).id;
    } else {
      if (!usesCookieAuthentication(c.req.method, c.req.path)) return null;
      const token = readAuthCookie(c, webConfiguration(c.env).accessName);
      if (!token) return null;
      c.header('Cache-Control', 'private, no-store');
      const session = await sessionFromAccess(c, token);
      requireTrustedOrigin(c);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) await requireCsrf(c.env, session, c.req.header('X-CSRF-Token'));
      id = session.user_id;
      sessionId = session.id;
    }
    const [user] = await c.get('db').select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.is_deleted, false))).limit(1);
    if (!user || !roles[user.user_type]) fail('UNAUTHORIZED_USER');
    authenticationState.set(c, { authed: user.is_authed });
    return { id: user.id, userType: user.user_type as Principal['userType'], ...(sessionId ? { sessionId } : {}) };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    authenticationState.set(c, { authed: false, error });
    return null;
  }
}

export function requirePrincipal(c: Context<ApiEnv>, permitted?: Principal['userType'][]): Principal {
  const principal = c.get('principal');
  if (!principal) throw authenticationState.get(c)?.error ?? new ApiError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
  if (permitted && !permitted.includes(principal.userType)) fail('FORBIDDEN_USER_TYPE');
  if (authenticationState.get(c)?.authed === false) {
    fail(principal.userType === 'OWNER' ? 'FORBIDDEN_OWNER' : principal.userType === 'STUDENT' ? 'FORBIDDEN_STUDENT' : principal.userType === 'ADMIN' ? 'FORBIDDEN_ADMIN' : 'FORBIDDEN_ACCOUNT');
  }
  return principal;
}
