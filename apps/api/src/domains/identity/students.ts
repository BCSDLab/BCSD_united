import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { allocateBigintId, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { buildResetStudentCourseCalculation } from '@api/domains/academic/graduation';
import { identityEvent, signalIdentityEvents } from '@api/domains/identity/events';
import {
  anonymousNickname,
  encodePassword,
  fail,
  issueNativeTokens,
  now,
  parseBody,
  passwordChangeStatements,
  passwordMatches,
  requireUnique,
  requireUser,
} from '@api/domains/identity/shared';
import { verificationConsumptionStatements } from '@api/domains/identity/verification';
import { sendEmail, sendSlack, studentPasswordResetEmail, studentRegistrationEmail } from '@api/integrations';
import { escapeHtml } from '@api/integrations/templates';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';

type Department = typeof schema.department.$inferSelect;
type Major = typeof schema.major.$inferSelect;
type Program = Pick<typeof schema.academic_program_year.$inferSelect, 'department_id' | 'major_id'>;
interface StudentRecord {
  student: typeof schema.students.$inferSelect;
  user: typeof schema.users.$inferSelect;
  department: Department | null;
  major: Major | null;
}
const nonblank = z.string().refine((value) => value.trim().length > 0);
const nickname = z
  .string()
  .max(10, '닉네임은 최대 10자입니다.')
  .regex(/^[가-힣a-zA-Z0-9]+$/, '한글, 영문 및 숫자만 사용할 수 있습니다.')
  .nullish();
const legacyName = z
  .string()
  .max(50, '이름은 50자 이내여야 합니다.')
  .regex(/^[가-힣a-zA-Z]+$/, '이름은 한글, 영문만 사용할 수 있습니다.')
  .nullish();
const name = z
  .string({ error: '이름은 필수입니다.' })
  .regex(/^(?:[가-힣]{2,5}|[A-Za-z]{2,30})$/, '이름은 한글 2-5자 또는 영문 2-30자로 입력해주세요.');
const gender = z.union([z.literal(0), z.literal(1)], { error: '올바르지 않은 성별 인덱스입니다.' });
const phone = z.string().regex(/^(\d{3}-\d{3,4}-\d{4}|\d{10,11})$/, '전화번호 형식이 올바르지 않습니다.');
const email = z
  .union([
    z.literal(''),
    z.email({ error: '이메일 형식이 올바르지 않습니다.' }).max(30, '이메일의 길이는 최대 30자 입니다.'),
  ])
  .nullish();
const studentNumber = z
  .string({ error: '학번은 필수입니다.' })
  .regex(/^[0-9]{8,10}$/, '학번엔 8-10자리 숫자만 입력 가능합니다.');
export const legacyStudentRegistration = z.object({
  email: z.email(),
  name: legacyName,
  password: nonblank,
  nickname,
  gender: gender.nullish(),
  is_graduated: z.boolean().default(false),
  major: nonblank,
  student_number: z.string().regex(/^[0-9]{10}$/),
  phone_number: phone.nullish(),
});
export const studentRegistration = z.object({
  name,
  nickname,
  email,
  phone_number: z
    .string({ error: '휴대폰 번호는 필수입니다.' })
    .regex(/^\d{11}$/, '전화번호 형식이 올바르지 않습니다. 11자리 숫자로 입력해 주세요.'),
  gender,
  department: nonblank,
  student_number: studentNumber,
  login_id: z
    .string({ error: '아이디는 필수입니다.' })
    .regex(/^(?=.*[a-z])[a-z0-9._-]{5,13}$/, '5-13자의 영소문자(필수), 숫자, 특수문자만 사용할 수 있습니다.'),
  password: nonblank.refine((value) => value.length === 64, '비밀번호 해시값은 16진수 64자여야 합니다.'),
  marketing_notification_agreement: z.boolean().default(false),
});
const legacyProfile = z.object({
  gender: gender.nullish(),
  major: nonblank,
  name: legacyName,
  password: z.string().nullish(),
  nickname,
  student_number: z.string().regex(/^[0-9]{10}$/),
  phone_number: phone.nullish(),
});
const profile = z.object({
  name,
  nickname,
  email,
  phone_number: phone,
  gender,
  major: nonblank,
  student_number: studentNumber,
  password: z.string().nullish(),
});
const academicProfile = z.object({
  student_number: z
    .string()
    .regex(/^[0-9]{10}$/)
    .nullish(),
  department: nonblank,
  major: z.string().nullish(),
});

function studentError(kind: 'number' | 'department' | 'major' | 'departmentMissing', detail: string): never {
  const errors = {
    number: [400, '학생의 학번 형식이 아닙니다.'],
    department: [400, '학생의 전공 형식이 아닙니다.'],
    major: [404, '존재하지 않는 전공입니다.'],
    departmentMissing: [404, '존재하지 않는 학과입니다.'],
  } as const;
  const [status, message] = errors[kind];
  throw new ApiError(status, '', `${message} ${detail}`);
}

export function validateStudentNumber(value: string | null, currentYear?: number): asserts value is string {
  if (value === null || !/^[0-9]{8,10}$/.test(value)) studentError('number', `studentNumber: ${value}`);
  if (currentYear !== undefined && (Number(value.slice(0, 4)) < 1992 || Number(value.slice(0, 4)) > currentYear))
    studentError('number', `studentNumber: ${value}`);
}

export function validateAcademicSelection(
  student: string | null,
  department: (Pick<Department, 'id'> & Partial<Pick<Department, 'name'>>) | null,
  major: (Pick<Major, 'id' | 'department_id'> & Partial<Pick<Major, 'name'>>) | null,
  programs: Program[],
): void {
  validateStudentNumber(student);
  if (!department) studentError('department', '학부가 필요합니다.');
  if (major && major.department_id !== department.id)
    studentError('major', `학부: ${department.name}, 전공: ${major.name}`);
  if (!programs.length) return;
  if (!programs.some((program) => program.department_id === department.id))
    studentError('department', `학번 연도: ${student.slice(0, 4)}, 학부: ${department.name}`);
  if (major && !programs.some((program) => program.department_id === department.id && program.major_id === major.id))
    studentError('major', `학번 연도: ${student.slice(0, 4)}, 전공: ${major.name}`);
}

export async function requireStudentDepartment(db: Database, value: string | null | undefined): Promise<Department> {
  if (!value?.trim()) studentError('department', `학부(학과) : ${value ?? null}`);
  const [department] = await db.select().from(schema.department).where(eq(schema.department.name, value)).limit(1);
  if (!department) studentError('department', `학부(학과) : ${value}`);
  return department;
}

async function academicPrograms(db: Database, value: string | null) {
  validateStudentNumber(value);
  return db
    .select()
    .from(schema.academic_program_year)
    .where(eq(schema.academic_program_year.student_year, value.slice(0, 4)))
    .orderBy(asc(schema.academic_program_year.department_id), asc(schema.academic_program_year.id));
}

export async function validateAcademicProgram(
  db: Database,
  value: string | null,
  department: Department | null,
  major: Major | null,
): Promise<void> {
  validateAcademicSelection(value, department, major, await academicPrograms(db, value));
}

export function defaultAcademicMajor(departmentId: number, programs: Program[], majors: Major[]): Major | null {
  if (!programs.length) {
    let first: Major | null = null;
    for (const major of majors) {
      if (major.department_id === departmentId && (first === null || major.id < first.id)) first = major;
    }
    return first;
  }
  for (const program of programs) {
    if (program.department_id !== departmentId || program.major_id === null) continue;
    const major = majors.find((candidate) => candidate.id === program.major_id && candidate.name === null);
    if (major) return major;
  }
  return null;
}

async function defaultMajor(db: Database, value: string | null, department: Department): Promise<Major | null> {
  const programs = await academicPrograms(db, value);
  const majors = await db
    .select()
    .from(schema.major)
    .where(eq(schema.major.department_id, department.id))
    .orderBy(asc(schema.major.id));
  return defaultAcademicMajor(department.id, programs, majors);
}

async function studentRecord(db: Database, id: number): Promise<StudentRecord> {
  const [record] = await db
    .select({ student: schema.students, user: schema.users, department: schema.department, major: schema.major })
    .from(schema.students)
    .innerJoin(schema.users, eq(schema.users.id, schema.students.user_id))
    .leftJoin(schema.department, eq(schema.department.id, schema.students.department_id))
    .leftJoin(schema.major, eq(schema.major.id, schema.students.major_id))
    .where(and(eq(schema.students.user_id, id), eq(schema.users.is_deleted, false)))
    .limit(1);
  if (!record) fail('NOT_FOUND_USER');
  return record;
}

function studentResponse(record: StudentRecord) {
  const { user, student, department } = record;
  return {
    anonymous_nickname: user.anonymous_nickname,
    email: user.email,
    gender: user.gender,
    major: department?.name ?? null,
    name: user.name,
    nickname: user.nickname,
    phone_number: user.phone_number,
    student_number: student.student_number,
  };
}

function tokenGuard(id: string, token: string, kind: string): SQL[] {
  const guard = crypto.randomUUID();
  return [
    sql`INSERT INTO identity_atomic_guards (id, allowed) VALUES (${guard}, EXISTS(SELECT 1 FROM identity_tokens WHERE id = ${id} AND kind = ${kind} AND json_extract(payload, '$.token') = ${token} AND expires_at > ${Date.now()}))`,
    sql`DELETE FROM identity_atomic_guards WHERE id = ${guard}`,
  ];
}

async function findStudentByEmail(db: Database, address: string) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.email, address),
        eq(schema.users.is_deleted, false),
        inArray(schema.users.user_type, ['STUDENT', 'COUNCIL']),
      ),
    )
    .limit(1);
  if (!user) fail('NOT_FOUND_USER');
  return user;
}

export function registerStudents(app: Hono<ApiEnv>): void {
  app.get('/user/student/me', async (c) => {
    const record = await studentRecord(c.get('db'), requirePrincipal(c, ['STUDENT', 'COUNCIL']).id);
    return c.json({
      id: record.user.id,
      login_id: record.user.user_id,
      ...studentResponse(record),
      user_type: record.user.user_type,
    });
  });
  app.get('/user/student/me/academic-info', async (c) => {
    const record = await studentRecord(c.get('db'), requirePrincipal(c, ['STUDENT', 'COUNCIL']).id);
    return c.json({
      id: record.user.id,
      ...studentResponse(record),
      department: record.department?.name ?? null,
      major: record.major?.name ?? null,
    });
  });
  for (const version of ['legacy', 'v2'] as const) {
    app.put(version === 'legacy' ? '/user/student/me' : '/v2/users/students/me', async (c) => {
      const id = requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
      const db = c.get('db');
      const updatedProfile = version === 'v2' ? await parseBody(c, profile) : null;
      const body = updatedProfile ?? (await parseBody(c, legacyProfile));
      const record = await studentRecord(db, id);
      await requireUnique(db, 'nickname', body.nickname, id);
      const verification: SQL[] = [];
      const address = updatedProfile === null ? record.user.email : (updatedProfile.email ?? null);
      if (version === 'v2') {
        await requireUnique(db, 'phone_number', body.phone_number, id);
        if (body.phone_number && body.phone_number !== record.user.phone_number)
          verification.push(...(await verificationConsumptionStatements(db, body.phone_number)));
        await requireUnique(db, 'email', address, id);
      }
      const department = await requireStudentDepartment(db, body.major);
      const changedDepartment = department.id !== record.student.department_id;
      const major = changedDepartment ? await defaultMajor(db, body.student_number, department) : record.major;
      await validateAcademicProgram(db, body.student_number, department, major);
      const reset =
        changedDepartment || body.student_number !== record.student.student_number
          ? await buildResetStudentCourseCalculation(db, id, major?.id ?? null, body.student_number)
          : [];
      const password = body.password?.trim()
        ? passwordChangeStatements(db, id, await encodePassword(body.password, true))
        : [];
      await executeAtomic(db, [
        ...verification,
        sql`UPDATE users SET email = ${address}, nickname = ${body.nickname ?? null}, name = ${body.name ?? null}, phone_number = ${body.phone_number ?? null}, gender = ${body.gender ?? null}, updated_at = ${now()} WHERE id = ${id}`,
        sql`UPDATE students SET student_number = ${body.student_number}, department_id = ${department.id}, major_id = ${major?.id ?? null} WHERE user_id = ${id}`,
        ...password,
        ...reset,
      ]);
      return c.json(studentResponse(await studentRecord(db, id)));
    });
  }
  app.put('/user/student/academic-info', async (c) => {
    const id = requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
    const db = c.get('db');
    const body = await parseBody(c, academicProfile);
    const department = await requireStudentDepartment(db, body.department);
    if (body.major != null) {
      const [known] = await db.select().from(schema.major).where(eq(schema.major.name, body.major)).limit(1);
      if (!known) studentError('major', `전공 : ${body.major}`);
    }
    const record = await studentRecord(db, id);
    const number = body.student_number ?? record.student.student_number;
    let major: Major | null;
    if (body.major != null) {
      const [selected] = await db
        .select()
        .from(schema.major)
        .where(and(eq(schema.major.name, body.major), eq(schema.major.department_id, department.id)))
        .limit(1);
      if (!selected) studentError('departmentMissing', `name: ${body.major}, departmentId: ${department.id}`);
      major = selected;
    } else {
      major =
        department.id === record.student.department_id ? record.major : await defaultMajor(db, number, department);
    }
    await validateAcademicProgram(db, number, department, major);
    const changed = number !== record.student.student_number || (major?.id ?? null) !== record.student.major_id;
    const reset = changed && number && major ? await buildResetStudentCourseCalculation(db, id, major.id, number) : [];
    await executeAtomic(db, [
      sql`UPDATE students SET student_number = ${number}, department_id = ${department.id}, major_id = ${major?.id ?? null} WHERE user_id = ${id}`,
      ...reset,
    ]);
    return c.json({ student_number: number, department: department.name, major: major?.name ?? null });
  });
  app.post('/student/login', async (c) => {
    const body = await parseBody(c, z.object({ email: nonblank, password: nonblank }));
    const db = c.get('db');
    const user = await findStudentByEmail(db, body.email);
    if (!(await passwordMatches(body.password, user.password))) fail('NOT_MATCHED_PASSWORD');
    const [pending] = await db
      .select()
      .from(schema.identity_tokens)
      .where(
        and(
          eq(schema.identity_tokens.kind, 'student_signup'),
          eq(schema.identity_tokens.target, body.email),
          gt(schema.identity_tokens.expires_at, Date.now()),
        ),
      )
      .limit(1);
    if (pending) throw new ApiError(403, '', '미인증 상태입니다. 아우누리에서 인증메일을 확인해주세요 null');
    const tokens = await issueNativeTokens(c, user);
    c.header('Location', '/');
    return c.json(tokens, 201);
  });
  app.post('/user/student/register', async (c) => {
    const body = await parseBody(c, legacyStudentRegistration);
    if (body.email.slice(body.email.lastIndexOf('@') + 1) !== 'koreatech.ac.kr')
      throw new ApiError(400, '', `유효하지 않는 이메일 주소입니다. account: ${body.email}`);
    const db = c.get('db');
    const [existingEmail] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.email, body.email), eq(schema.users.is_deleted, false)))
      .limit(1);
    if (existingEmail) throw new ApiError(409, '', `이미 존재하는 이메일입니다. email: ${body.email}`);
    const pending = await db
      .select()
      .from(schema.identity_tokens)
      .where(and(eq(schema.identity_tokens.kind, 'student_signup'), gt(schema.identity_tokens.expires_at, Date.now())));
    if (pending.some((item) => item.target === body.email))
      throw new ApiError(409, '', `이미 존재하는 이메일입니다. email: ${body.email}`);
    if (body.nickname != null) {
      const [existingNickname] = await db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.nickname, body.nickname), eq(schema.users.is_deleted, false)))
        .limit(1);
      if (
        existingNickname ||
        pending.some(
          (item) =>
            item.payload && legacyStudentRegistration.parse(JSON.parse(item.payload)).nickname === body.nickname,
        )
      )
        fail('DUPLICATE_NICKNAME');
    }
    validateStudentNumber(body.student_number, new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear());
    const department = await requireStudentDepartment(db, body.major);
    await validateAcademicProgram(db, body.student_number, department, null);
    const token = crypto.randomUUID();
    const payload = JSON.stringify({ ...body, phone_number: body.phone_number?.replaceAll('-', '') ?? null, token });
    const event = identityEvent('identity.student.signup-request', {
      email: body.email,
      serverUrl: new URL(c.req.url).origin,
      token,
    });
    const slack = identityEvent('identity.student.signup-slack', { email: body.email });
    await executeAtomic(db, [
      sql`DELETE FROM identity_tokens WHERE kind = 'student_signup' AND target = ${body.email} AND expires_at <= ${Date.now()}`,
      sql`INSERT INTO identity_tokens (id, kind, target, payload, expires_at) VALUES (${'student_signup:' + body.email}, 'student_signup', ${body.email}, ${payload}, ${Date.now() + 36_000_000})`,
      event.statement,
      slack.statement,
    ]);
    await signalIdentityEvents(c.env, [event.id, slack.id]);
    return c.body(null, 200);
  });
  app.get('/user/authenticate', async (c) => {
    const token = c.req.query('auth_token');
    if (!token?.trim())
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '토큰은 필수입니다.', [
        { field: 'auth_token', message: '토큰은 필수입니다.', constraint: 'NotBlank' },
      ]);
    const db = c.get('db');
    const [pending] = await db
      .select()
      .from(schema.identity_tokens)
      .where(
        and(
          eq(schema.identity_tokens.kind, 'student_signup'),
          gt(schema.identity_tokens.expires_at, Date.now()),
          sql`json_extract(${schema.identity_tokens.payload}, '$.token') = ${token}`,
        ),
      )
      .limit(1);
    if (!pending?.payload) return c.html(studentView('error'));
    const body = legacyStudentRegistration.parse(JSON.parse(pending.payload));
    const department = await requireStudentDepartment(db, body.major);
    const major = await defaultMajor(db, body.student_number, department);
    await validateAcademicProgram(db, body.student_number, department, major);
    const anonymous = anonymousNickname();
    const event = identityEvent('identity.student.registered', { contact: body.email });
    await executeAtomic(db, [
      ...tokenGuard(pending.id, token, 'student_signup'),
      sql`INSERT INTO users (user_id, password, name, nickname, email, gender, phone_number, user_type, is_authed, is_deleted, anonymous_nickname) VALUES (${body.email.slice(0, body.email.indexOf('@'))}, ${await encodePassword(body.password)}, ${body.name ?? null}, ${body.nickname ?? null}, ${body.email}, ${body.gender ?? null}, ${body.phone_number ?? null}, 'STUDENT', 1, 0, ${anonymous})`,
      sql`INSERT INTO students (user_id, student_number, department_id, major_id, identity, is_graduated) SELECT id, ${body.student_number}, ${department.id}, ${major?.id ?? null}, 0, ${body.is_graduated ? 1 : 0} FROM users WHERE anonymous_nickname = ${anonymous}`,
      sql`DELETE FROM identity_tokens WHERE id = ${pending.id}`,
      event.statement,
    ]);
    await signalIdentityEvents(c.env, [event.id]);
    return c.html(studentView('success'));
  });
  app.post('/v2/users/students/register', async (c) => {
    const body = await parseBody(c, studentRegistration);
    const db = c.get('db');
    const department = await requireStudentDepartment(db, body.department);
    await requireUnique(db, 'nickname', body.nickname);
    await requireUnique(db, 'phone_number', body.phone_number);
    await requireUnique(db, 'email', body.email);
    await requireUnique(db, 'user_id', body.login_id);
    await validateAcademicProgram(db, body.student_number, department, null);
    const verification = await verificationConsumptionStatements(db, body.phone_number);
    const anonymous = anonymousNickname();
    const marketing: SQL[] = body.marketing_notification_agreement
      ? [
          sql`INSERT INTO notification_subscribe (id, created_at, updated_at, subscribe_type, user_id) SELECT ${await allocateBigintId(db, 'notification_subscribe')}, ${now()}, ${now()}, 'MARKETING', id FROM users WHERE anonymous_nickname = ${anonymous}`,
        ]
      : [];
    const event = identityEvent('identity.student.registered', { contact: body.phone_number });
    await executeAtomic(db, [
      ...verification,
      sql`INSERT INTO users (user_id, password, name, nickname, email, gender, phone_number, user_type, is_authed, is_deleted, anonymous_nickname, device_token) VALUES (${body.login_id}, ${await encodePassword(body.password)}, ${body.name}, ${body.nickname ?? null}, ${body.email ?? null}, ${body.gender}, ${body.phone_number}, 'STUDENT', 1, 0, ${anonymous}, 'TEMPORARY_TOKEN')`,
      sql`INSERT INTO students (user_id, student_number, department_id, is_graduated) SELECT id, ${body.student_number}, ${department.id}, 0 FROM users WHERE anonymous_nickname = ${anonymous}`,
      ...marketing,
      event.statement,
    ]);
    await signalIdentityEvents(c.env, [event.id]);
    return c.body(null, 201);
  });
  app.post('/user/find/password', async (c) => {
    const body = await parseBody(c, z.object({ email: z.string().regex(/^[a-zA-Z0-9._%+-]+@koreatech\.ac\.kr$/) }));
    const db = c.get('db');
    const user = await findStudentByEmail(db, body.email);
    const token = crypto.randomUUID();
    const event = identityEvent('identity.student.reset-password', {
      email: body.email,
      serverUrl: new URL(c.req.url).origin,
      token,
    });
    await executeAtomic(db, [
      sql`INSERT INTO identity_tokens (id, kind, target, user_id, payload, expires_at) VALUES (${'student_reset:' + user.id}, 'student_reset', ${body.email}, ${user.id}, ${JSON.stringify({ token })}, ${Date.now() + 3_600_000}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      event.statement,
    ]);
    await signalIdentityEvents(c.env, [event.id]);
    return c.body(null, 201);
  });
  app.put('/user/change/password', async (c) => {
    const id = requirePrincipal(c, ['STUDENT', 'COUNCIL']).id;
    const db = c.get('db');
    await studentRecord(db, id);
    const body = await parseBody(c, z.object({ password: z.string().nullish() }));
    const user = await requireUser(db, id);
    const hash = body.password?.trim() ? await encodePassword(body.password, true) : user.password;
    await executeAtomic(db, passwordChangeStatements(db, id, hash));
    return c.body(null, 200);
  });
  app.get('/user/change/password/config', (c) => {
    const token = c.req.query('reset_token');
    if (token === undefined) fail('INVALID_REQUEST_BODY');
    return c.html(studentView('password', new URL(c.req.url).origin, token));
  });
  app.post('/user/change/password/submit', async (c) => {
    const token = c.req.query('reset_token');
    if (token === undefined) fail('INVALID_REQUEST_BODY');
    const body = await parseBody(c, z.object({ password: z.string().nullish() }));
    const db = c.get('db');
    const [reset] = await db
      .select()
      .from(schema.identity_tokens)
      .where(
        and(
          eq(schema.identity_tokens.kind, 'student_reset'),
          gt(schema.identity_tokens.expires_at, Date.now()),
          sql`json_extract(${schema.identity_tokens.payload}, '$.token') = ${token}`,
        ),
      )
      .limit(1);
    if (!reset?.user_id) fail('NOT_FOUND_RESET_TOKEN');
    const user = await requireUser(db, reset.user_id);
    const password = body.password?.trim()
      ? passwordChangeStatements(db, user.id, await encodePassword(body.password, true))
      : [];
    await executeAtomic(db, [
      ...tokenGuard(reset.id, token, 'student_reset'),
      ...password,
      sql`DELETE FROM identity_tokens WHERE id = ${reset.id}`,
    ]);
    return c.body(null, 200);
  });
}

export async function handleStudentJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind === 'identity.student.signup-request') {
    await sendEmail(env, {
      to: String(job.payload.email),
      ...studentRegistrationEmail(String(job.payload.serverUrl), String(job.payload.token)),
    });
    return true;
  }
  if (job.kind === 'identity.student.reset-password') {
    await sendEmail(env, {
      to: String(job.payload.email),
      ...studentPasswordResetEmail(String(job.payload.serverUrl), String(job.payload.token)),
    });
    return true;
  }
  if (job.kind === 'identity.student.registered' || job.kind === 'identity.student.signup-slack') {
    if (!env.SLACK_KOIN_EVENT_NOTIFY_URL)
      throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Student Slack notification webhook is not configured.');
    const text =
      job.kind === 'identity.student.registered'
        ? `${String(job.payload.contact)}(학생)님이 가입하셨습니다.`
        : `${String(job.payload.email)}(학생)님이 이메일 인증을 요청하셨습니다.`;
    await sendSlack(env, { webhook: env.SLACK_KOIN_EVENT_NOTIFY_URL, message: '`' + text + '`\n' });
    return true;
  }
  return false;
}

export function studentView(view: 'error' | 'success' | 'password', serverUrl = '', token = ''): string {
  const head =
    '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>코인 이메일 인증 폼</title><link rel="shortcut icon" href="https://static.koreatech.in/favicon.ico"></head>';
  if (view === 'error')
    return (
      head + '<body><script>alert("토큰이 유효하지 않습니다.");location.href="//koreatech.in";</script></body></html>'
    );
  const form =
    view === 'password'
      ? `<p>패스워드를 입력해주세요.(6자이상 18자 이하의 특수문자를 포함)</p><input type="hidden" id="requestUrl" value="${escapeHtml(serverUrl + '/user/change/password/submit?reset_token=' + encodeURIComponent(token))}"><p>비밀번호 입력 : <input type="password" id="password"></p><p>비밀번호 확인 : <input type="password" id="password_confirm"></p><input type="button" id="submitButton" value="비밀번호 변경">`
      : '회원 가입을 위한 인증이 완료되었습니다.<br><br>';
  const script =
    view === 'password'
      ? `<script>document.getElementById('submitButton').addEventListener('click',async()=>{const password=document.getElementById('password').value.trim();if(password!==document.getElementById('password_confirm').value.trim()){alert('패스워드가 일치하지 않습니다. 다시 입력해주세요.');return;}if(!/^(?=.*[a-zA-Z])(?=.*[!@#$%^*+=-])(?=.*[0-9]).{6,18}$/.test(password)){alert('특수문자를 포함한 영어와 숫자 6~18 자리를 입력하세요');return;}try{const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(password));const response=await fetch(document.getElementById('requestUrl').value,{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({password:Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')})});if(response.ok){alert('비밀번호 변경 성공!\\n변경된 비밀번호로 로그인해주세요.');location.href='//koreatech.in';}else{alert(response.status===401?'유효시간이 만료되었습니다.\\n메일을 재전송하여 진행해주세요.':'서버와의 통신 중 오류가 발생했습니다.');}}catch{alert('서버와의 통신 중 오류가 발생했습니다.');}});</script>`
      : '';
  return (
    head +
    `<body style="margin:0;padding:0"><table align="center" width="600" style="border:1px solid #ccc"><tr><td align="center" bgcolor="#EAEAEA" style="padding:40px 0 30px"><img src="https://static.koreatech.in/mail_form_logo.png" alt="Creating Email Magic" width="300" height="295"></td></tr><tr><td style="padding:40px 30px;text-align:center;font-family:Arial,sans-serif"><b style="color:#153643;font-size:24px">${view === 'password' ? '비밀번호 변경 안내' : '회원 가입 완료 안내'}</b><p>안녕하세요.<br><br>한국기술교육대학교 커뮤니티 코인 운영팀입니다.<br><br></p>${form}</td></tr><tr><td bgcolor="#2F2F2F" style="padding:30px;color:white;font-family:Arial,sans-serif">Copyright BCSD Lab, TEAM_KAP All rights reserved.</td></tr></table>${script}</body></html>`
  );
}
