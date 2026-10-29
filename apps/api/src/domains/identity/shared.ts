import { compare, hash } from 'bcryptjs';
import { and, eq, gt, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { requirePrincipal, signJwt } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { fail } from '@api/domains/identity/errors';
import { ApiError } from '@api/errors';
import type { ApiEnv, Principal } from '@api/runtime';

export { fail } from '@api/domains/identity/errors';
export type User = typeof schema.users.$inferSelect;
export const KOIN_USER_TYPES: Principal['userType'][] = ['GENERAL', 'STUDENT', 'COUNCIL'];
export const USER_TYPES: Principal['userType'][] = ['GENERAL', 'STUDENT', 'COUNCIL', 'OWNER', 'COOP'];

export function now(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export function anonymousNickname(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(13));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function parseBody<T>(c: Context<ApiEnv>, validator: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    fail('NOT_READABLE_HTTP_MESSAGE');
  }
  const parsed = validator.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      constraint: issue.code,
    }));
    throw new ApiError(400, 'INVALID_REQUEST_BODY', errors[0]?.message ?? '요청 본문이 올바르지 않습니다.', errors);
  }
  return parsed.data;
}

export async function requireUser(db: Database, id: number): Promise<User> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.is_deleted, false)))
    .limit(1);
  if (!user) fail('NOT_FOUND_USER');
  return user;
}

export async function requireUnique(
  db: Database,
  field: 'user_id' | 'email' | 'phone_number' | 'nickname',
  value: string | null | undefined,
  exceptId?: number,
): Promise<void> {
  if (!value?.trim()) return;
  const [found] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users[field], value),
        eq(schema.users.is_deleted, false),
        inArray(schema.users.user_type, KOIN_USER_TYPES),
        exceptId === undefined ? undefined : ne(schema.users.id, exceptId),
      ),
    )
    .limit(1);
  if (found)
    fail(
      {
        user_id: 'DUPLICATE_LOGIN_ID',
        email: 'DUPLICATE_EMAIL',
        phone_number: 'DUPLICATE_PHONE_NUMBER',
        nickname: 'DUPLICATE_NICKNAME',
      }[field],
    );
}

export async function encodePassword(value: string, stripHyphens = false): Promise<string> {
  return hash(stripHyphens ? value.replaceAll('-', '') : value, 10);
}

export async function passwordMatches(value: string, encoded: string): Promise<boolean> {
  return compare(value, encoded);
}

/**
 * 배치 맨 앞뒤에 넣어 `condition`이 거짓이면 CHECK 제약 위반으로 배치 전체를 롤백시킨다.
 * 호출자는 `identity_atomic_guards`가 포함된 오류 메시지로 가드 실패를 구분한다.
 */
export function atomicGuard(condition: SQL): SQL[] {
  const id = crypto.randomUUID();
  return [
    sql`INSERT INTO identity_atomic_guards (id, allowed) VALUES (${id}, CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    sql`DELETE FROM identity_atomic_guards WHERE id = ${id}`,
  ];
}

/** 비밀번호를 바꾸면 웹·네이티브 세션을 모두 끊는다. `_db`는 읽지 않지만 호출부·테스트가 같은 시그니처를 쓰므로 남긴다. */
export function passwordChangeStatements(_db: Database, userId: number, encoded: string): SQL[] {
  return [
    sql`UPDATE users SET password = ${encoded}, updated_at = ${now()} WHERE id = ${userId} AND is_deleted = 0`,
    sql`DELETE FROM identity_web_sessions WHERE user_id = ${userId}`,
    sql`DELETE FROM identity_native_sessions WHERE user_id = ${userId}`,
  ];
}

export async function changePassword(
  db: Database,
  userId: number,
  password: string,
  stripHyphens = true,
): Promise<void> {
  if (!password.trim()) return;
  const user = await requireUser(db, userId);
  const unchanged = sql`EXISTS(SELECT 1 FROM users WHERE id = ${userId} AND password = ${user.password} AND is_deleted = 0)`;
  await executeAtomic(db, [
    ...atomicGuard(unchanged),
    ...passwordChangeStatements(db, userId, await encodePassword(password, stripHyphens)),
  ]);
}

export function nativePlatform(userAgent: string | undefined): string {
  if (/tablet|ipad/i.test(userAgent ?? '')) return 'Tablet';
  if (/mobile|mobi|android|iphone|ios|windows phone/i.test(userAgent ?? '')) return 'Mobile';
  return 'PC';
}

export async function issueNativeTokens(
  c: Context<ApiEnv>,
  user: User,
): Promise<{ token: string; refresh_token: string }> {
  const token = await signJwt(c.env, user.id);
  const platform = nativePlatform(c.req.header('User-Agent'));
  const refresh_token = `${crypto.randomUUID()}-${user.id}`;
  const id = `${user.id}:${platform}`;
  await executeAtomic(c.get('db'), [
    ...atomicGuard(
      sql`EXISTS(SELECT 1 FROM users WHERE id = ${user.id} AND password = ${user.password} AND is_deleted = 0)`,
    ),
    sql`INSERT INTO identity_native_sessions (id,user_id,platform,token,expires_at) VALUES (${id},${user.id},${platform},${refresh_token},${Date.now() + 7776000000}) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`,
    sql`UPDATE users SET last_logged_at = ${now()} WHERE id = ${user.id}`,
  ]);
  return { token, refresh_token };
}

export async function nativeRefresh(
  c: Context<ApiEnv>,
  refreshToken: string,
  permitted?: Principal['userType'][],
): Promise<{ token: string; refresh_token: string }> {
  if (!refreshToken || refreshToken.includes('.')) fail('INVALID_REFRESH_TOKEN');
  const suffix = refreshToken.split('-').at(-1)!;
  if (!/^\d+$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) fail('INVALID_REFRESH_TOKEN');
  const id = Number(suffix);
  const key = `${id}:${nativePlatform(c.req.header('User-Agent'))}`;
  const [session] = await c
    .get('db')
    .select()
    .from(schema.identity_native_sessions)
    .where(and(eq(schema.identity_native_sessions.id, key), gt(schema.identity_native_sessions.expires_at, Date.now())))
    .limit(1);
  if (!session) fail('NOT_FOUND_REFRESH_TOKEN');
  if (session.token !== refreshToken) fail('NOT_MATCHED_REFRESH_TOKEN');
  const user = await requireUser(c.get('db'), id);
  if (permitted && !permitted.includes(user.user_type as Principal['userType'])) fail('FORBIDDEN_USER_TYPE');
  return { token: await signJwt(c.env, id), refresh_token: session.token };
}

export async function nativeLogout(c: Context<ApiEnv>, id: number): Promise<void> {
  await c
    .get('db')
    .delete(schema.identity_native_sessions)
    .where(eq(schema.identity_native_sessions.id, `${id}:${nativePlatform(c.req.header('User-Agent'))}`));
}

export async function requireAdminPermission(c: Context<ApiEnv>, group: string): Promise<User> {
  const principal = requirePrincipal(c, ['ADMIN']);
  const user = await requireUser(c.get('db'), principal.id);
  const [admin] = await c
    .get('db')
    .select()
    .from(schema.admins)
    .where(eq(schema.admins.user_id, principal.id))
    .limit(1);
  if (!admin) throw new ApiError(404, 'NOT_FOUND', '어드민 계정이 존재하지 않습니다.');
  if (group === 'SUPER' && !admin.super_admin) throw new ApiError(403, 'FORBIDDEN', '권한이 없습니다.');
  return user;
}

export async function loginUser(
  c: Context<ApiEnv>,
  identifier: string,
  password: string,
  byEmail = false,
): Promise<User> {
  const column = byEmail
    ? schema.users.email
    : /^\d{11}$/.test(identifier)
      ? schema.users.phone_number
      : schema.users.user_id;
  const [user] = await c
    .get('db')
    .select()
    .from(schema.users)
    .where(
      and(eq(column, identifier), eq(schema.users.is_deleted, false), inArray(schema.users.user_type, KOIN_USER_TYPES)),
    )
    .limit(1);
  if (!user) fail('NOT_FOUND_USER');
  if (!(await passwordMatches(password, user.password))) fail('NOT_MATCHED_PASSWORD');
  return user;
}
