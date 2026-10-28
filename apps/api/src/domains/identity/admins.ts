import { and, asc, count, desc, eq, like, sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { sendSlack } from '@api/integrations';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { identityEvent, signalIdentityEvents } from '@api/domains/identity/events';
import {
  anonymousNickname, changePassword, encodePassword, fail, issueNativeTokens,
  nativeLogout, nativeRefresh, now, parseBody, passwordMatches, requireAdminPermission,
  passwordChangeStatements, requireUnique, requireUser, type User,
} from '@api/domains/identity/shared';
import { requireStudentDepartment, validateAcademicProgram } from '@api/domains/identity/students';
import { withdrawUser } from '@api/domains/identity/users';

export interface AdminPagination {
  page: number;
  limit: number;
  offset: number;
}

interface AdminStudent {
  student: typeof schema.students.$inferSelect;
  user: User;
  department: typeof schema.department.$inferSelect | null;
}

const tracks = ['ANDROID', 'BACKEND', 'FRONTEND', 'GAME', 'PM', 'PL', 'DESIGN', 'IOS', 'DA', 'SECURITY'] as const;
const trackLabels: Record<string, string> = {
  ANDROID: 'Android', BACKEND: 'Backend', FRONTEND: 'Frontend', GAME: 'Game', PM: 'PM',
  PL: 'PL', DESIGN: 'Design', IOS: 'iOS', DA: 'DA', SECURITY: 'Security',
};
const nonblank = z.string().refine((value) => value.trim().length > 0);
const nullableText = (max: number) => z.string().max(max).nullish();
export const createAdminBody = z.object({
  email: nonblank, password: nonblank, name: nonblank.pipe(z.string().max(50)), track_name: z.enum(tracks),
});
export const adminStudentBody = z.object({
  gender: z.number().int().nullish(), major: nonblank, name: nullableText(50),
  password: z.string().nullish(), nickname: nullableText(10), phone_number: nullableText(20),
  student_number: z.string().regex(/^[0-9]{10}$/),
});
export const adminOwnerBody = z.object({
  company_registration_number: nullableText(12), email: nullableText(100),
  gender: z.number().int().nullish(), grant_shop: z.boolean().nullish(), grant_event: z.boolean().nullish(),
  name: nullableText(50), nickname: nullableText(10), phone_number: nullableText(20), password: z.string().nullish(),
});

export function adminPagination(page: number | undefined, limit: number | undefined, total: number): AdminPagination {
  const size = Math.max(1, Math.min(50, limit ?? 10));
  const current = Math.max(1, Math.min(page ?? 1, Math.max(1, Math.ceil(total / size))));
  return { page: current, limit: size, offset: (current - 1) * size };
}

export function validateAdminEmail(email: string): void {
  if (!email.endsWith('@koreatech.ac.kr')) throw new ApiError(400, '400', '유효하지 않는 이메일 주소입니다.');
  if (!/^koin\d{5}@koreatech\.ac\.kr$/.test(email)) throw new ApiError(400, '400', '어드민 계정 양식에 맞지 않습니다');
}

export function validateOwnerSearch(query: string | undefined, searchType: string | undefined): void {
  if (query === undefined) return;
  if (searchType === undefined) throw new ApiError(400, '400', '검색 내용이 존재할 경우 검색 대상은 필수입니다.');
  if (query.length === 0) throw new ApiError(400, '400', '검색 내용의 최소 길이는 1입니다.');
  if (!query.trim()) throw new ApiError(400, '400', '검색 내용은 공백 문자로만 이루어져 있으면 안됩니다.');
}

export function ownerAdminChanges(input: z.infer<typeof adminOwnerBody>) {
  if (input.company_registration_number == null || input.grant_shop == null || input.grant_event == null) {
    throw new TypeError('Owner registration number and grant flags cannot be null');
  }
  return {
    company_registration_number: input.company_registration_number,
    grant_shop: Number(input.grant_shop), grant_event: Number(input.grant_event),
  };
}

function integerQuery(c: Context<ApiEnv>, key: string): number | undefined {
  const value = c.req.query(key);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_REQUEST_BODY');
  return Number(value);
}

function booleanQuery(c: Context<ApiEnv>, key: string): boolean | undefined {
  const value = c.req.query(key);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail('INVALID_REQUEST_BODY');
}

function targetId(c: Context<ApiEnv>): number {
  const value = c.req.param('id');
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_REQUEST_BODY');
  return Number(value);
}

function timestamp(value: string | null): string | null {
  if (!value) return null;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
    .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour12: false }).replace(',', '');
}

function managerResponse(row: { admin: typeof schema.admins.$inferSelect; user: User }) {
  return {
    id: row.user.id, email: row.admin.email, name: row.user.name,
    track_name: trackLabels[row.admin.track_type], super_admin: row.admin.super_admin, is_authed: row.user.is_authed,
  };
}

async function manager(db: Database, id: number) {
  const [row] = await db.select({ admin: schema.admins, user: schema.users }).from(schema.admins)
    .innerJoin(schema.users, eq(schema.users.id, schema.admins.user_id))
    .where(and(eq(schema.admins.user_id, id), eq(schema.users.is_deleted, false))).limit(1);
  if (!row) throw new ApiError(404, '404', '어드민을 찾을 수 없습니다.');
  return row;
}

async function student(db: Database, id: number): Promise<AdminStudent> {
  const [row] = await db.select({ student: schema.students, user: schema.users, department: schema.department })
    .from(schema.students).innerJoin(schema.users, eq(schema.users.id, schema.students.user_id))
    .leftJoin(schema.department, eq(schema.department.id, schema.students.department_id))
    .where(and(eq(schema.students.user_id, id), eq(schema.users.is_deleted, false))).limit(1);
  if (!row) fail('NOT_FOUND_USER');
  return row;
}

function studentUpdateResponse(row: AdminStudent) {
  return {
    anonymous_nickname: row.user.anonymous_nickname, email: row.user.email, gender: row.user.gender,
    major: row.department?.name ?? null, name: row.user.name, nickname: row.user.nickname,
    phone_number: row.user.phone_number, student_number: row.student.student_number,
  };
}

async function owner(db: Database, id: number) {
  const [row] = await db.select({ owner: schema.owners, user: schema.users }).from(schema.owners)
    .innerJoin(schema.users, eq(schema.users.id, schema.owners.user_id))
    .where(and(eq(schema.owners.user_id, id), eq(schema.users.is_deleted, false))).limit(1);
  if (!row) throw new ApiError(404, '404', '사장님을 찾을 수 없습니다.');
  return row;
}

async function requestedShop(db: Database, id: number) {
  const [token] = await db.select().from(schema.identity_tokens)
    .where(and(eq(schema.identity_tokens.id, `owner_shop:${id}`), sql`${schema.identity_tokens.expires_at} > ${Date.now()}`)).limit(1);
  if (!token) return null;
  const payload = JSON.parse(token.payload ?? '{}') as { shop_id?: number | null };
  if (payload.shop_id == null) return null;
  const [shop] = await db.select({ id: schema.shops.id, name: schema.shops.name }).from(schema.shops)
    .where(and(eq(schema.shops.id, payload.shop_id), eq(schema.shops.is_deleted, false))).limit(1);
  return shop ?? null;
}

function pageResponse(total: number, currentCount: number, paging: AdminPagination) {
  return { total_count: total, current_count: currentCount, total_page: Math.ceil(total / paging.limit), current_page: paging.page };
}

async function listOwners(c: Context<ApiEnv>, authed: boolean) {
  await requireAdminPermission(c, 'OWNER');
  const db = c.get('db');
  const query = c.req.query('query');
  const searchType = c.req.query('searchType');
  const sort = c.req.query('sort') ?? 'CREATED_AT_ASC';
  if (searchType !== undefined && searchType !== 'EMAIL' && searchType !== 'NAME') fail('INVALID_REQUEST_BODY');
  if (sort !== 'CREATED_AT_ASC' && sort !== 'CREATED_AT_DESC') fail('INVALID_REQUEST_BODY');
  validateOwnerSearch(query, searchType);
  const base = and(eq(schema.users.is_deleted, false), eq(schema.users.is_authed, authed));
  const [all] = await db.select({ total: count() }).from(schema.users)
    .where(and(base, eq(schema.users.user_type, 'OWNER')));
  const paging = adminPagination(integerQuery(c, 'page'), integerQuery(c, 'limit'), all!.total);
  const search = searchType === undefined ? undefined : query === undefined ? sql`0 = 1`
    : like(searchType === 'EMAIL' ? schema.users.email : schema.users.name, `%${query}%`);
  const filter = and(base, search);
  const [matched] = await db.select({ total: count() }).from(schema.owners)
    .innerJoin(schema.users, eq(schema.users.id, schema.owners.user_id)).where(filter);
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name,
    phone_number: schema.users.phone_number, created_at: schema.users.created_at }).from(schema.owners)
    .innerJoin(schema.users, eq(schema.users.id, schema.owners.user_id)).where(filter)
    .orderBy(sort === 'CREATED_AT_ASC' ? asc(schema.users.created_at) : desc(schema.users.created_at))
    .limit(paging.limit).offset(paging.offset);
  const owners = await Promise.all(rows.map(async (row) => {
    const common = { ...row, created_at: timestamp(row.created_at) };
    if (authed) return common;
    const shop = await requestedShop(db, row.id);
    return { ...common, shop_id: shop?.id ?? null, shop_name: shop?.name ?? null };
  }));
  return c.json({ ...pageResponse(matched!.total, rows.length, paging), owners });
}

export function registerAdmins(app: Hono<ApiEnv>): void {
  app.post('/admin', async (c) => {
    const actor = await requireAdminPermission(c, 'SUPER');
    const body = await parseBody(c, createAdminBody);
    validateAdminEmail(body.email);
    const db = c.get('db');
    const [duplicate] = await db.select({ id: schema.admins.user_id }).from(schema.admins).where(eq(schema.admins.email, body.email)).limit(1);
    if (duplicate) throw new ApiError(409, '409', '이미 존재하는 이메일입니다.');
    const actorAdmin = await manager(db, actor.id);
    const password = await encodePassword(body.password);
    const loginId = body.email.slice(0, body.email.indexOf('@'));
    const event = identityEvent('admin-created', { creator_id: actorAdmin.admin.login_id, creator_name: actor.name,
      target_id: loginId, target_name: body.name });
    const result = await executeAtomic(db, [
      sql`INSERT INTO ${schema.users} (password, name, user_type, is_authed, is_deleted, anonymous_nickname) VALUES (${password}, ${body.name}, 'ADMIN', 1, 0, ${anonymousNickname()})`,
      sql`INSERT INTO ${schema.admins} (user_id, email, login_id, track_type, team_type, super_admin, can_create_admin) VALUES (last_insert_rowid(), ${body.email}, ${loginId}, ${body.track_name}, 'KOIN', 0, 0)`,
      event.statement,
    ]);
    await signalIdentityEvents(c.env, [event.id]);
    c.header('Location', `/${result[0]!.meta.last_row_id}`);
    return c.body(null, 201);
  });

  app.put('/admin/password', async (c) => {
    const actor = await requireAdminPermission(c, 'ADMIN');
    const body = await parseBody(c, z.object({ old_password: nonblank, new_password: nonblank }));
    await manager(c.get('db'), actor.id);
    if (!await passwordMatches(body.old_password, actor.password)) fail('NOT_MATCHED_PASSWORD');
    await changePassword(c.get('db'), actor.id, body.new_password, true);
    return c.body(null, 200);
  });

  app.post('/admin/user/login', async (c) => {
    const body = await parseBody(c, z.object({ email: nonblank, password: nonblank }));
    const db = c.get('db');
    const [admin] = await db.select({ id: schema.admins.user_id }).from(schema.admins).where(eq(schema.admins.email, body.email)).limit(1);
    if (!admin) throw new ApiError(404, '404', '어드민을 찾을 수 없습니다.');
    const user = await requireUser(db, admin.id);
    if (user.user_type !== 'ADMIN') fail('NOT_FOUND_USER');
    if (!await passwordMatches(body.password, user.password)) fail('NOT_MATCHED_PASSWORD');
    if (!user.is_authed) throw new ApiError(403, '403', 'PL 인증 대기중입니다.');
    const tokens = await issueNativeTokens(c, user);
    await db.update(schema.users).set({ last_logged_at: now(), updated_at: now() }).where(eq(schema.users.id, user.id));
    c.header('Location', '/');
    return c.json(tokens, 201);
  });
  app.post('/admin/user/logout', async (c) => {
    const user = await requireAdminPermission(c, 'ADMIN');
    await nativeLogout(c, user.id);
    return c.body(null, 200);
  });
  app.post('/admin/user/refresh', async (c) => {
    const body = await parseBody(c, z.object({ refresh_token: nonblank }));
    const tokens = await nativeRefresh(c, body.refresh_token);
    c.header('Location', '/');
    return c.json(tokens, 201);
  });

  app.get('/admin', async (c) => {
    const actor = await requireAdminPermission(c, 'ADMIN');
    return c.json(managerResponse(await manager(c.get('db'), actor.id)));
  });
  app.get('/admin/:id{[0-9]+}', async (c) => {
    await requireAdminPermission(c, 'ADMIN');
    return c.json(managerResponse(await manager(c.get('db'), targetId(c))));
  });
  app.get('/admins', async (c) => {
    await requireAdminPermission(c, 'ADMIN');
    const db = c.get('db');
    const track = c.req.query('trackName');
    const team = c.req.query('teamName');
    if (track !== undefined && !tracks.some((value) => value === track)) fail('INVALID_REQUEST_BODY');
    if (team !== undefined && !['KOIN', 'BUSINESS', 'CAMPUS', 'USER'].includes(team)) fail('INVALID_REQUEST_BODY');
    const authed = booleanQuery(c, 'isAuthed');
    const [all] = await db.select({ total: count() }).from(schema.admins);
    const paging = adminPagination(integerQuery(c, 'page'), integerQuery(c, 'limit'), all!.total);
    const filter = and(eq(schema.users.is_deleted, false), track === undefined ? undefined : eq(schema.admins.track_type, track),
      team === undefined ? undefined : eq(schema.admins.team_type, team), authed === undefined ? undefined : eq(schema.users.is_authed, authed));
    const [matched] = await db.select({ total: count() }).from(schema.admins)
      .innerJoin(schema.users, eq(schema.users.id, schema.admins.user_id)).where(filter);
    const rows = await db.select({ admin: schema.admins, user: schema.users }).from(schema.admins)
      .innerJoin(schema.users, eq(schema.users.id, schema.admins.user_id)).where(filter).limit(paging.limit).offset(paging.offset);
    return c.json({ ...pageResponse(matched!.total, rows.length, paging), admins: rows.map(managerResponse) });
  });
  app.put('/admin/:id/authed', async (c) => {
    const actor = await requireAdminPermission(c, 'SUPER');
    const body = await parseBody(c, z.object({ is_authed: z.boolean() }));
    const db = c.get('db');
    const target = await manager(db, targetId(c));
    const creator = await manager(db, actor.id);
    const event = identityEvent('admin-authentication-changed', { creator_id: creator.admin.login_id, creator_name: actor.name,
      target_id: target.admin.login_id, target_name: target.user.name, is_authed: body.is_authed });
    await executeAtomic(db, [sql`UPDATE ${schema.users} SET is_authed = ${Number(body.is_authed)}, updated_at = ${now()} WHERE id = ${target.user.id}`, event.statement]);
    await signalIdentityEvents(c.env, [event.id]);
    return c.body(null, 200);
  });
  app.put('/admin/:id/permission', async (c) => {
    await requireAdminPermission(c, 'SUPER');
    const body = await parseBody(c, z.object({ super_admin: z.boolean() }));
    const target = await manager(c.get('db'), targetId(c));
    await c.get('db').update(schema.admins).set({ super_admin: body.super_admin }).where(eq(schema.admins.user_id, target.user.id));
    return c.body(null, 200);
  });
  app.put('/admin/:id{[0-9]+}', async (c) => {
    await requireAdminPermission(c, 'ADMIN');
    const body = await parseBody(c, z.object({ name: nonblank, track_name: z.enum(tracks) }));
    const target = await manager(c.get('db'), targetId(c));
    await executeAtomic(c.get('db'), [
      sql`UPDATE ${schema.users} SET name = ${body.name}, updated_at = ${now()} WHERE id = ${target.user.id}`,
      sql`UPDATE ${schema.admins} SET track_type = ${body.track_name} WHERE user_id = ${target.user.id}`,
    ]);
    return c.body(null, 200);
  });

  app.get('/admin/users/student/:id', async (c) => {
    await requireAdminPermission(c, 'STUDENT');
    const row = await student(c.get('db'), targetId(c));
    return c.json({ ...studentUpdateResponse(row), id: row.user.id, user_type: row.user.user_type,
      is_authed: row.user.is_authed, last_logged_at: timestamp(row.user.last_logged_at),
      created_at: timestamp(row.user.created_at), updated_at: timestamp(row.user.updated_at), is_graduated: row.student.is_graduated });
  });
  app.get('/admin/students', async (c) => {
    await requireAdminPermission(c, 'STUDENT');
    const db = c.get('db');
    const [all] = await db.select({ total: count() }).from(schema.students);
    const paging = adminPagination(integerQuery(c, 'page'), integerQuery(c, 'limit'), all!.total);
    const authed = booleanQuery(c, 'isAuthed');
    const nickname = c.req.query('nickname');
    const email = c.req.query('email');
    const filter = and(eq(schema.users.is_deleted, false), authed === undefined ? undefined : eq(schema.users.is_authed, authed),
      nickname === undefined ? undefined : like(schema.users.nickname, `%${nickname}%`), email === undefined ? undefined : like(schema.users.email, `%${email}%`));
    const [matched] = await db.select({ total: count() }).from(schema.students)
      .innerJoin(schema.users, eq(schema.users.id, schema.students.user_id)).where(filter);
    const rows = await db.select({ id: schema.users.id, email: schema.users.email, major: schema.department.name,
      name: schema.users.name, nickname: schema.users.nickname, student_number: schema.students.student_number })
      .from(schema.students).innerJoin(schema.users, eq(schema.users.id, schema.students.user_id))
      .leftJoin(schema.department, eq(schema.department.id, schema.students.department_id))
      .where(filter).limit(paging.limit).offset(paging.offset);
    return c.json({ ...pageResponse(matched!.total, rows.length, paging), students: rows });
  });
  app.put('/admin/users/student/:id', async (c) => {
    await requireAdminPermission(c, 'STUDENT');
    const body = await parseBody(c, adminStudentBody);
    const db = c.get('db');
    const row = await student(db, targetId(c));
    await requireUnique(db, 'nickname', body.nickname, row.user.id);
    const department = await requireStudentDepartment(db, body.major);
    const [major] = row.student.major_id == null ? [] : await db.select().from(schema.major).where(eq(schema.major.id, row.student.major_id)).limit(1);
    await validateAcademicProgram(db, body.student_number, department, major ?? null);
    if (body.gender != null && body.gender !== 0 && body.gender !== 1) fail('INVALID_GENDER_INDEX');
    const statements: SQL[] = [
      sql`UPDATE ${schema.users} SET nickname = ${body.nickname ?? null}, name = ${body.name ?? null}, phone_number = ${body.phone_number ?? null}, gender = ${body.gender ?? null}, updated_at = ${now()} WHERE id = ${row.user.id}`,
      sql`UPDATE ${schema.students} SET student_number = ${body.student_number}, department_id = ${department.id} WHERE user_id = ${row.user.id}`,
    ];
    if (body.password?.trim()) {
      statements.push(...passwordChangeStatements(db, row.user.id, await encodePassword(body.password, true)));
    }
    await executeAtomic(db, statements);
    return c.json(studentUpdateResponse(await student(db, row.user.id)));
  });

  app.get('/admin/users/new-owners', (c) => listOwners(c, false));
  app.get('/admin/users/owners', (c) => listOwners(c, true));
  app.get('/admin/users/owner/:id', async (c) => {
    await requireAdminPermission(c, 'OWNER');
    const db = c.get('db');
    const row = await owner(db, targetId(c));
    const attachments = await db.select({ url: schema.owner_attachments.url }).from(schema.owner_attachments)
      .where(and(eq(schema.owner_attachments.owner_id, row.user.id), eq(schema.owner_attachments.is_deleted, false)));
    const shops = await db.select({ id: schema.shops.id }).from(schema.shops)
      .where(and(eq(schema.shops.owner_id, row.user.id), eq(schema.shops.is_deleted, false)));
    return c.json({ id: row.user.id, email: row.user.email, name: row.user.name, nickname: row.user.nickname,
      company_registration_number: row.owner.company_registration_number, attachments_url: attachments.map((item) => item.url),
      shops_id: shops.map((item) => item.id), phone_number: row.owner.account, is_authed: row.user.is_authed,
      user_type: row.user.user_type, gender: row.user.gender, created_at: timestamp(row.user.created_at),
      updated_at: timestamp(row.user.updated_at), last_logged_at: timestamp(row.user.last_logged_at) });
  });
  app.put('/admin/users/owner/:id', async (c) => {
    await requireAdminPermission(c, 'OWNER');
    const body = await parseBody(c, adminOwnerBody);
    const db = c.get('db');
    const row = await owner(db, targetId(c));
    const changes = ownerAdminChanges(body);
    await db.update(schema.owners).set(changes).where(eq(schema.owners.user_id, row.user.id));
    return c.json({ company_registration_number: changes.company_registration_number, email: row.user.email,
      gender: row.user.gender, grant_shop: Boolean(changes.grant_shop), grant_event: Boolean(changes.grant_event),
      name: row.user.name, nickname: row.user.nickname, phone_number: row.owner.account });
  });
  app.put('/admin/owner/:id/authed', async (c) => {
    await requireAdminPermission(c, 'OWNER');
    const db = c.get('db');
    const row = await owner(db, targetId(c));
    const [token] = await db.select().from(schema.identity_tokens)
      .where(and(eq(schema.identity_tokens.id, `owner_shop:${row.user.id}`), sql`${schema.identity_tokens.expires_at} > ${Date.now()}`)).limit(1);
    const payload = token ? JSON.parse(token.payload ?? '{}') as { shop_id?: number | null } : null;
    const statements: SQL[] = [sql`UPDATE ${schema.users} SET is_authed = 1, updated_at = ${now()} WHERE id = ${row.user.id}`];
    if (payload?.shop_id != null) {
      const shop = await requestedShop(db, row.user.id);
      if (!shop) throw new ApiError(404, '404', '상점을 찾을 수 없습니다.');
      statements.push(sql`UPDATE ${schema.shops} SET owner_id = ${row.user.id}, updated_at = ${now()} WHERE id = ${shop.id}`,
        sql`UPDATE ${schema.owners} SET grant_shop = 1 WHERE user_id = ${row.user.id}`);
    }
    await executeAtomic(db, statements);
    return c.body(null, 200);
  });

  app.get('/admin/users/:id', async (c) => {
    await requireAdminPermission(c, 'USER');
    const user = await requireUser(c.get('db'), targetId(c));
    return c.json({ id: user.id, name: user.name, nickname: user.nickname, anonymousNickname: user.anonymous_nickname,
      phoneNumber: user.phone_number, email: user.email, profileImageUrl: user.profile_image_url,
      loginId: user.user_id, loginPw: user.password, deviceToken: user.device_token, userType: user.user_type,
      gender: user.gender == null ? null : user.gender === 0 ? 'MAN' : 'WOMAN', authed: user.is_authed, deleted: user.is_deleted,
      lastLoggedAt: timestamp(user.last_logged_at)?.replace(' ', 'T') ?? null,
      createdAt: timestamp(user.created_at)?.replace(' ', 'T'), updatedAt: timestamp(user.updated_at)?.replace(' ', 'T'),
      displayNickname: user.nickname?.trim() ? user.nickname : user.anonymous_nickname?.trim() ? user.anonymous_nickname : '익명 사용자',
      koinStudent: user.user_type === 'STUDENT' || user.user_type === 'COUNCIL' });
  });
  app.delete('/admin/users/:id', async (c) => {
    await requireAdminPermission(c, 'USER');
    await withdrawUser(c, targetId(c));
    return c.body(null, 200);
  });
  app.post('/admin/users/:id/undelete', async (c) => {
    await requireAdminPermission(c, 'USER');
    const user = await requireUser(c.get('db'), targetId(c));
    await c.get('db').update(schema.users).set({ is_deleted: false, updated_at: now() }).where(eq(schema.users.id, user.id));
    return c.body(null, 200);
  });
}

export async function handleAdminIdentityJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'admin-created' && job.kind !== 'admin-authentication-changed') return false;
  const p = job.payload;
  const actor = `${String(p.creator_name)}(${String(p.creator_id)})`;
  const target = `${String(p.target_name)}(${String(p.target_id)})`;
  const action = job.kind === 'admin-created' ? '생성' : p.is_authed ? '활성화' : '비활성화';
  const message = `\`${actor}님이 ${target} 어드민 계정을 ${action}했습니다.\`\n`;
  if (!env.SLACK_KOIN_EVENT_NOTIFY_URL) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'SLACK_KOIN_EVENT_NOTIFY_URL 설정이 필요합니다.');
  await sendSlack(env, { webhook: env.SLACK_KOIN_EVENT_NOTIFY_URL, message });
  return true;
}
