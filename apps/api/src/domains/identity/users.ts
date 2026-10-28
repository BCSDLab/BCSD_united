import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal, verifyJwt } from '@api/auth';
import { allocateBigintId, executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { identityEvent, signalIdentityEvents } from '@api/domains/identity/events';
import {
  anonymousNickname, changePassword, encodePassword, fail, issueNativeTokens, KOIN_USER_TYPES, loginUser, nativeLogout, nativeRefresh, now,
  parseBody, passwordChangeStatements, passwordMatches, requireUnique, requireUser, USER_TYPES, type User,
} from '@api/domains/identity/shared';
import { consumeVerification, verificationConsumptionStatements } from '@api/domains/identity/verification';
import { buildCommerceWithdrawal } from '@api/domains/commerce/withdrawal';
import { buildTeamWithdrawal } from '@api/domains/team/core';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

const nonblank = z.string().refine(value => value.trim().length > 0, '필수 입력 사항입니다.');
const phone = z.string().regex(/^010[0-9]{8}$/, '올바른 전화번호 형식이 아닙니다.');
const email = z.string().email('올바른 이메일 형식이 아닙니다.');
const loginId = z.string().regex(/^[a-z0-9_.-]{1,13}$/);
const profileSchema = z.object({
  name: z.string().regex(/^(?:[가-힣]{2,5}|[A-Za-z]{2,30})$/, '이름은 한글 2-5자 또는 영문 2-30자로 입력해주세요.'),
  nickname: z.string().max(10).regex(/^[가-힣a-zA-Z0-9]+$/).nullish(),
  email: z.union([z.literal(''), email.max(30)]).nullish(),
  phone_number: z.string().regex(/^\d{11}$/),
  gender: z.union([z.literal(0), z.literal(1)]),
  password: z.string().nullish(),
});
export const userRegistrationSchema = profileSchema.extend({
  login_id: z.string().regex(/^(?=.*[a-z])[a-z0-9._-]{5,13}$/),
  password: z.string().length(64),
  marketing_notification_agreement: z.boolean().default(false),
});

function userResponse(user: User) {
  return { id: user.id, login_id: user.user_id, email: user.email, gender: user.gender, name: user.name, nickname: user.nickname, phone_number: user.phone_number, user_type: user.user_type };
}

async function byIdentity(c: Context<ApiEnv>, field: 'phone_number' | 'email' | 'user_id', value: string): Promise<User> {
  const [user] = await c.get('db').select().from(schema.users).where(and(eq(schema.users[field], value), eq(schema.users.is_deleted, false), inArray(schema.users.user_type, KOIN_USER_TYPES))).limit(1);
  if (!user) fail('NOT_FOUND_USER');
  return user;
}

/** 인증 소비 가드가 실패하면(인증 없음·만료) 본문 변경도 함께 롤백된다. */
async function consumeAndWrite(c: Context<ApiEnv>, target: string, statements: SQL[]): Promise<void> {
  try {
    await executeAtomic(c.get('db'), [...await verificationConsumptionStatements(c.get('db'), target), ...statements]);
  } catch (error) {
    if (String(error).includes('identity_atomic_guards')) fail('FORBIDDEN_VERIFICATION');
    throw error;
  }
}

export async function withdrawUser(c: Context<ApiEnv>, userId: number): Promise<void> {
  const db = c.get('db');
  const user = await requireUser(db, userId);
  const descriptions: Record<string, string> = { GENERAL: '일반', STUDENT: '학생', COUNCIL: '총학생회', OWNER: '사장님', COOP: '영양사', ADMIN: '어드민' };
  const event = identityEvent('identity.slack', { message: `\`${user.phone_number ?? 'null'}(${descriptions[user.user_type]})님이 탈퇴하셨습니다.\`\n` });
  await executeAtomic(db, [
    ...await buildTeamWithdrawal(db, userId),
    ...await buildCommerceWithdrawal(db, userId),
    sql`DELETE FROM timetable_frame WHERE user_id=${userId}`,
    sql`DELETE FROM students WHERE user_id=${userId}`,
    sql`DELETE FROM owner_attachments WHERE owner_id=${userId}`,
    sql`DELETE FROM owners WHERE user_id=${userId}`,
    sql`DELETE FROM users WHERE id=${userId}`,
    sql`DELETE FROM team_recruitment_user_lock WHERE user_id=${userId}`,
    event.statement,
  ]);
  await signalIdentityEvents(c.env, [event.id]);
}

export function registerUsers(app: Hono<ApiEnv>): void {
  app.get('/v2/users/me', async c => c.json(userResponse(await requireUser(c.get('db'), requirePrincipal(c, ['GENERAL']).id))));
  app.get('/v3/users/me', async c => {
    const user = await requireUser(c.get('db'), requirePrincipal(c, KOIN_USER_TYPES).id);
    let studentNumber: string | null = null;
    let major: string | null = null;
    if (user.user_type === 'STUDENT' || user.user_type === 'COUNCIL') {
      const [student] = await c.get('db').select({ number: schema.students.student_number, major: schema.department.name }).from(schema.students).leftJoin(schema.department, eq(schema.students.department_id, schema.department.id)).where(eq(schema.students.user_id, user.id)).limit(1);
      if (!student) fail('NOT_FOUND_USER');
      studentNumber = student.number;
      major = student.major;
    }
    return c.json({ ...userResponse(user), anonymous_nickname: user.anonymous_nickname, student_number: studentNumber, major });
  });
  app.get('/user/auth', async c => c.json({ user_type: requirePrincipal(c, USER_TYPES).userType }));
  app.post('/v2/users/register', async c => {
    const request = await parseBody(c, userRegistrationSchema);
    const db = c.get('db');
    await Promise.all([requireUnique(db, 'nickname', request.nickname), requireUnique(db, 'phone_number', request.phone_number), requireUnique(db, 'email', request.email), requireUnique(db, 'user_id', request.login_id)]);
    const password = await encodePassword(request.password);
    const statements: SQL[] = [sql`INSERT INTO users (password,name,nickname,anonymous_nickname,phone_number,user_type,email,gender,is_authed,is_deleted,device_token,user_id) VALUES (${password},${request.name},${request.nickname ?? null},${anonymousNickname()},${request.phone_number},'GENERAL',${request.email ?? null},${request.gender},1,0,'TEMPORARY_TOKEN',${request.login_id})`];
    if (request.marketing_notification_agreement) {
      const id = await allocateBigintId(db, 'notification_subscribe');
      statements.push(sql`INSERT INTO notification_subscribe (id,user_id,subscribe_type,detail_type,created_at,updated_at) SELECT ${id},id,'MARKETING',NULL,${now()},${now()} FROM users WHERE user_id=${request.login_id}`);
    }
    const event = identityEvent('identity.slack', { message: `\`${request.phone_number}(일반인)님이 가입하셨습니다.\`\n` });
    statements.push(event.statement);
    await consumeAndWrite(c, request.phone_number, statements);
    await signalIdentityEvents(c.env, [event.id]);
    return c.body(null, 201);
  });
  app.post('/v2/users/login', async c => {
    const request = await parseBody(c, z.object({ login_id: nonblank, login_pw: nonblank }));
    const user = await loginUser(c, request.login_id, request.login_pw);
    const tokens = await issueNativeTokens(c, user);
    c.header('Location', '/');
    return c.json({ ...tokens, user_type: user.user_type }, 201);
  });
  app.post('/user/login', async c => {
    const request = await parseBody(c, z.object({ email, password: nonblank }));
    const user = await loginUser(c, request.email, request.password, true);
    const [pending] = await c.get('db').select().from(schema.identity_tokens).where(and(eq(schema.identity_tokens.kind, 'student_signup'), eq(schema.identity_tokens.target, request.email), gt(schema.identity_tokens.expires_at, Date.now()))).limit(1);
    if (pending) throw new ApiError(403, '', '미인증 상태입니다. 아우누리에서 인증메일을 확인해주세요 null');
    const tokens = await issueNativeTokens(c, user);
    c.header('Location', '/');
    return c.json({ ...tokens, user_type: user.user_type }, 201);
  });
  app.post('/user/refresh', async c => {
    const request = await parseBody(c, z.object({ refresh_token: nonblank }));
    const result = await nativeRefresh(c, request.refresh_token);
    c.header('Location', '/');
    return c.json(result, 201);
  });
  app.post('/user/logout', async c => {
    await nativeLogout(c, requirePrincipal(c, USER_TYPES).id);
    return c.body(null, 200);
  });
  app.post('/users/id/find/sms', async c => {
    const request = await parseBody(c, z.object({ phone_number: phone }));
    const user = await byIdentity(c, 'phone_number', request.phone_number);
    await consumeVerification(c.get('db'), request.phone_number);
    return c.json({ login_id: user.user_id });
  });
  app.post('/users/id/find/email', async c => {
    const request = await parseBody(c, z.object({ email }));
    const user = await byIdentity(c, 'email', request.email);
    await consumeVerification(c.get('db'), request.email);
    return c.json({ login_id: user.user_id });
  });
  app.post('/users/password/reset/sms', async c => {
    const request = await parseBody(c, z.object({ login_id: loginId, phone_number: phone, new_password: nonblank }));
    const user = await byIdentity(c, 'user_id', request.login_id);
    if (user.phone_number !== request.phone_number) fail('NOT_MATCHED_PHONE_NUMBER');
    await consumeAndWrite(c, request.phone_number, passwordChangeStatements(c.get('db'), user.id, await encodePassword(request.new_password, true)));
    return c.body(null, 200);
  });
  app.post('/users/password/reset/email', async c => {
    const request = await parseBody(c, z.object({ login_id: loginId, email, new_password: nonblank }));
    const user = await byIdentity(c, 'user_id', request.login_id);
    if (user.email !== request.email) fail('NOT_MATCHED_EMAIL');
    await consumeAndWrite(c, request.email, passwordChangeStatements(c.get('db'), user.id, await encodePassword(request.new_password, true)));
    return c.body(null, 200);
  });
  app.put('/v2/users/me', async c => {
    const user = await requireUser(c.get('db'), requirePrincipal(c, ['GENERAL']).id);
    const request = await parseBody(c, profileSchema);
    await Promise.all([requireUnique(c.get('db'), 'nickname', request.nickname, user.id), requireUnique(c.get('db'), 'email', request.email, user.id), requireUnique(c.get('db'), 'phone_number', request.phone_number, user.id)]);
    const statements: SQL[] = [sql`UPDATE users SET name=${request.name},nickname=${request.nickname ?? null},email=${request.email ?? null},phone_number=${request.phone_number},gender=${request.gender},updated_at=${now()} WHERE id=${user.id}`];
    if (request.password?.trim()) statements.push(...passwordChangeStatements(c.get('db'), user.id, await encodePassword(request.password, true)));
    if (request.phone_number !== user.phone_number) await consumeAndWrite(c, request.phone_number, statements);
    else await executeAtomic(c.get('db'), statements);
    return c.json({ gender: request.gender, email: request.email ?? null, name: request.name, nickname: request.nickname ?? null, phone_number: request.phone_number });
  });
  app.put('/users/password', async c => {
    const principal = requirePrincipal(c, USER_TYPES);
    const request = await parseBody(c, z.object({ new_password: z.string().nullish() }));
    if (request.new_password?.trim()) await changePassword(c.get('db'), principal.id, request.new_password);
    return c.body(null, 200);
  });
  app.delete('/user', async c => {
    await withdrawUser(c, requirePrincipal(c, USER_TYPES).id);
    return c.body(null, 204);
  });
  app.get('/user/check/login', async c => {
    await verifyJwt(c.env, c.req.query('accessToken') ?? c.req.query('access_token') ?? '');
    return c.body(null, 200);
  });
  app.get('/user/check/id', async c => {
    const value = z.string().min(1).max(13).parse(c.req.query('loginId') ?? c.req.query('login_id') ?? c.req.query('id'));
    await requireUnique(c.get('db'), 'user_id', value);
    return c.body(null, 200);
  });
  app.get('/user/check/phone', async c => {
    const value = nonblank.parse(c.req.query('phone'));
    await requireUnique(c.get('db'), 'phone_number', value);
    return c.body(null, 200);
  });
  app.get('/user/check/email', async c => {
    const value = email.parse(c.req.query('email') ?? c.req.query('address'));
    await requireUnique(c.get('db'), 'email', value);
    return c.body(null, 200);
  });
  app.get('/user/check/nickname', async c => {
    const value = z.string().min(1).max(10).parse(c.req.query('nickname'));
    await requireUnique(c.get('db'), 'nickname', value);
    return c.body(null, 200);
  });
  app.post('/user/check/password', async c => {
    const user = await requireUser(c.get('db'), requirePrincipal(c, USER_TYPES).id);
    const request = await parseBody(c, z.object({ password: nonblank }));
    if (!await passwordMatches(request.password, user.password)) fail('NOT_MATCHED_PASSWORD');
    return c.body(null, 200);
  });
  app.post('/user/id/exists', async c => {
    const request = await parseBody(c, z.object({ login_id: loginId }));
    await byIdentity(c, 'user_id', request.login_id);
    return c.body(null, 200);
  });
  app.post('/user/phone/exists', async c => {
    const request = await parseBody(c, z.object({ phone_number: phone }));
    await byIdentity(c, 'phone_number', request.phone_number);
    return c.body(null, 200);
  });
  app.post('/user/email/exists', async c => {
    const request = await parseBody(c, z.object({ email }));
    await byIdentity(c, 'email', request.email);
    return c.body(null, 200);
  });
  app.post('/users/id/match/phone', async c => {
    const request = await parseBody(c, z.object({ login_id: loginId, phone_number: phone }));
    const user = await byIdentity(c, 'user_id', request.login_id);
    if (user.phone_number !== request.phone_number) fail('NOT_MATCHED_PHONE_NUMBER');
    return c.body(null, 200);
  });
  app.post('/users/id/match/email', async c => {
    const request = await parseBody(c, z.object({ login_id: loginId, email }));
    const user = await byIdentity(c, 'user_id', request.login_id);
    if (user.email !== request.email) fail('NOT_MATCHED_EMAIL');
    return c.body(null, 200);
  });
  app.post('/coop/login', async c => {
    const request = await parseBody(c, z.object({ id: nonblank, password: nonblank }));
    const [record] = await c.get('db').select({ user: schema.users }).from(schema.coop).innerJoin(schema.users, eq(schema.coop.user_id, schema.users.id)).where(and(eq(schema.coop.coop_id, request.id), eq(schema.users.is_deleted, false))).limit(1);
    if (!record) throw new ApiError(404, '', `영양사님 계정이 존재하지 않습니다. loginId : ${request.id}`);
    if (!await passwordMatches(request.password, record.user.password)) fail('NOT_MATCHED_PASSWORD');
    const tokens = await issueNativeTokens(c, record.user);
    c.header('Location', '/');
    return c.json(tokens, 201);
  });
  app.get('/user/coop/me', async c => {
    const user = await requireUser(c.get('db'), requirePrincipal(c, ['COOP']).id);
    return c.json({ email: user.email, gender: user.gender, name: user.name, phone_number: user.phone_number, user_type: user.user_type });
  });
}
