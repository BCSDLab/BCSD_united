import { sql, type SQL } from 'drizzle-orm';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { closureStatements, deadlineScheduleStatement, notificationStatements } from '@api/domains/team/chat';
import {
  applicationInput,
  applyBlockReason,
  categoryNames,
  criteria,
  dDay,
  fail,
  kstDay,
  meetingNames,
  parse,
  validateProfile,
  validateRecruitment,
  type TeamError,
} from '@api/domains/team/policy';

const r = schema.team_recruitment;
const role = schema.team_recruitment_role;
const a = schema.team_recruitment_application;
const room = schema.team_recruitment_chat_room;
const member = schema.team_recruitment_chat_member;
const profile = schema.team_recruitment_profile;
const skill = schema.team_recruitment_profile_skill;
const activity = schema.team_recruitment_profile_activity;
type Recruitment = typeof r.$inferSelect;
type Role = typeof role.$inferSelect;
type Application = typeof a.$inferSelect;
type Query = Record<string, string | undefined>;
/**
 * 배치 안에서 상태 검증을 하는 문장. 조건이 거짓이면 `json_extract`에 잘못된 JSON을 넘겨 SQLite가
 * `malformed JSON` 오류로 배치 전체를 롤백하게 만든다. `atomic`이 그 오류를 `conflict` 코드로 바꾼다.
 */
const assert = (condition: SQL) =>
  sql`SELECT CASE WHEN (${condition}) THEN 1 ELSE json_extract('team recruitment state changed', '$') END`;
const now = sql`strftime('%Y-%m-%d %H:%M:%f','now')`;

async function atomic(db: Database, statements: SQL[], conflict: TeamError = 'TEAM_RECRUITMENT_CLOSED') {
  try {
    return await executeAtomic(db, statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('malformed JSON') || message.includes('team recruitment state changed')) fail(conflict);
    throw error;
  }
}
async function recruitment(db: Database, id: number, userId?: number, includeDeleted = false) {
  const value = await db.get<Recruitment>(sql`SELECT * FROM ${r} WHERE id=${id}`);
  if (!value) fail('TEAM_RECRUITMENT_NOT_FOUND');
  if (userId !== undefined && value.author_id !== userId) fail('TEAM_RECRUITMENT_FORBIDDEN');
  if (!includeDeleted && value.status === 'DELETED') fail('TEAM_RECRUITMENT_NOT_FOUND');
  return value;
}
function recruitmentSnapshot(id: number) {
  return sql`SELECT json_object('recruitment', (SELECT json_object('author',author_id,'category',category,'title',title,'meeting',meeting_type,'start',activity_start_date,'end',activity_end_date,'deadline',deadline_date,'type',recruitment_type,'max',max_participants,'current',current_participants,'description',description,'url',related_url,'qualification',qualification,'status',status,'deleted',deleted_at) FROM ${r} WHERE id=${id}), 'roles', (SELECT json_group_array(json_object('id',id,'name',name,'max',max_participants,'current',current_participants,'order',display_order)) FROM (SELECT * FROM ${role} WHERE recruitment_id=${id} ORDER BY id)), 'applications', (SELECT json_group_array(json_object('id',id,'user',applicant_id,'status',status,'role',role_id)) FROM (SELECT * FROM ${a} WHERE recruitment_id=${id} ORDER BY id))) AS value`;
}
async function frozenRecruitment(db: Database, id: number) {
  const query = recruitmentSnapshot(id);
  const snapshot = await db.get<{ value: string }>(query);
  return assert(sql`(${query}) = ${snapshot!.value}`);
}
export async function getProfile(
  db: Database,
  userId: number,
  required: TeamError = 'TEAM_RECRUITMENT_PROFILE_NOT_FOUND',
) {
  const value = await db.get<{
    profile_nickname: string;
    preferred_role: string;
    self_introduction: string;
    student_number: string | null;
    department: string | null;
    major: string | null;
    department_id: number | null;
  }>(
    sql`SELECT p.profile_nickname,p.preferred_role,p.self_introduction,s.student_number,s.department_id,d.name AS department,m.name AS major FROM ${profile} p JOIN ${schema.students} s ON s.user_id=p.user_id LEFT JOIN ${schema.department} d ON d.id=s.department_id LEFT JOIN ${schema.major} m ON m.id=s.major_id WHERE p.user_id=${userId}`,
  );
  if (!value) fail(required);
  const [skills, activities] = await Promise.all([
    db.all<{ skill: string }>(sql`SELECT skill FROM ${skill} WHERE profile_user_id=${userId} ORDER BY display_order`),
    db.all<{
      id: number;
      title: string;
      started_at: string;
      ended_at: string | null;
      is_ongoing: number;
      description: string;
    }>(
      sql`SELECT id,title,started_at,ended_at,is_ongoing,description FROM ${activity} WHERE profile_user_id=${userId} ORDER BY display_order`,
    ),
  ]);
  return {
    profile_nickname: value.profile_nickname,
    department: value.department,
    major: value.major,
    student_number: value.student_number,
    preferred_role: value.preferred_role,
    skills: skills.map((item) => item.skill),
    activities: activities.map((item) => ({ ...item, is_ongoing: Boolean(item.is_ongoing) })),
    self_introduction: value.self_introduction,
  };
}
export async function upsertProfile(db: Database, userId: number, input: unknown) {
  const value = validateProfile(input);
  const statements = [
    assert(sql`EXISTS(SELECT 1 FROM ${schema.students} WHERE user_id=${userId})`),
    sql`INSERT INTO ${profile} (user_id,profile_nickname,preferred_role,self_introduction) VALUES (${userId},${value.profile_nickname},${value.preferred_role},${value.self_introduction}) ON CONFLICT(user_id) DO UPDATE SET profile_nickname=excluded.profile_nickname,preferred_role=excluded.preferred_role,self_introduction=excluded.self_introduction,updated_at=${now}`,
    sql`DELETE FROM ${skill} WHERE profile_user_id=${userId}`,
    sql`DELETE FROM ${activity} WHERE profile_user_id=${userId}`,
    ...value.skills.map(
      (item, index) =>
        sql`INSERT INTO ${skill} (profile_user_id,skill,display_order) VALUES (${userId},${item},${index + 1})`,
    ),
    ...value.activities.map(
      (item, index) =>
        sql`INSERT INTO ${activity} (profile_user_id,title,started_at,ended_at,is_ongoing,description,display_order) VALUES (${userId},${item.title},${item.started_at},${item.ended_at},${Number(item.is_ongoing)},${item.description},${index + 1})`,
    ),
  ];
  await atomic(db, statements, 'TEAM_RECRUITMENT_PROFILE_REQUIRED');
  return getProfile(db, userId);
}
export async function card(db: Database, value: Recruitment, effective = false) {
  const roles = await db.all<Role>(sql`SELECT * FROM ${role} WHERE recruitment_id=${value.id} ORDER BY display_order`);
  const today = kstDay();
  const past = value.deadline_date < today;
  const status = effective && past && value.status === 'RECRUITING' ? 'CLOSED' : value.status;
  return {
    id: value.id,
    category: value.category,
    title: value.title,
    meeting_type: value.meeting_type,
    activity_start_date: value.activity_start_date,
    activity_end_date: value.activity_end_date,
    deadline_date: value.deadline_date,
    d_day: dDay(status, value.deadline_date, today),
    status,
    recruitment_type: value.recruitment_type,
    current_participants: value.current_participants,
    max_participants: value.max_participants,
    roles: roles.map((item) => ({
      id: item.id,
      name: item.name,
      current_participants: item.current_participants,
      max_participants: item.max_participants,
      is_closed: status !== 'RECRUITING' || past || item.current_participants >= item.max_participants,
    })),
  };
}
export async function detail(db: Database, id: number, userId: number | null) {
  const value = await recruitment(db, id);
  const [view, application, ownProfile, teamRoom, author] = await Promise.all([
    card(db, value),
    userId === null
      ? undefined
      : db.get<Application>(sql`SELECT * FROM ${a} WHERE recruitment_id=${id} AND applicant_id=${userId}`),
    userId === null ? undefined : db.get(sql`SELECT user_id FROM ${profile} WHERE user_id=${userId}`),
    db.get<{ id: number }>(sql`SELECT id FROM ${room} WHERE recruitment_id=${id} AND room_scope_key='TEAM'`),
    value.author_id === null
      ? undefined
      : db.get<{ nickname: string | null }>(sql`SELECT nickname FROM ${schema.users} WHERE id=${value.author_id}`),
  ]);
  const isAuthor = userId !== null && value.author_id === userId;
  const block = applyBlockReason(
    {
      deleted: false,
      userId,
      isAuthor,
      applied: Boolean(application),
      status: value.status,
      deadline: value.deadline_date,
      full: view.roles.length
        ? view.roles.every((item) => item.current_participants >= item.max_participants)
        : value.current_participants >= value.max_participants,
      hasProfile: Boolean(ownProfile),
    },
    kstDay(),
  );
  const roomId = isAuthor || application?.status === 'ACCEPTED' ? (teamRoom?.id ?? null) : null;
  return {
    ...view,
    author_nickname: value.author_id === null ? '탈퇴한 회원' : (author?.nickname ?? null),
    description: value.description,
    related_url: value.related_url,
    qualification: value.qualification,
    created_at: new Date(Date.parse(value.created_at.replace(' ', 'T') + 'Z') + 9 * 3_600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19),
    is_author: isAuthor,
    can_apply: block === null,
    apply_block_reason: block,
    application: application ? { application_id: application.id, status: application.status } : null,
    can_manage_applicants: isAuthor,
    team_chat_available: roomId !== null,
    team_chat_room_id: roomId,
  };
}
function enumQuery(value: string | undefined, values: string[], fallback?: string) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) fail('INVALID_REQUEST_BODY');
  return value;
}
export async function listRecruitments(db: Database, query: Query, authorId?: number) {
  const status = enumQuery(query.status, ['ALL', 'RECRUITING', 'CLOSED'], 'ALL');
  const sort = enumQuery(query.sort, ['LATEST_DESC', 'DEADLINE_ASC'], 'LATEST_DESC');
  const filters: SQL[] = [status === 'ALL' ? sql`status IN ('RECRUITING','CLOSED')` : sql`status=${status}`];
  if (authorId !== undefined) filters.push(sql`author_id=${authorId}`);
  else {
    if (query.categories) {
      const categories = query.categories.split(',').map((value) => enumQuery(value, Object.keys(categoryNames))!);
      filters.push(
        sql`category IN (${sql.join(
          categories.map((value) => sql`${value}`),
          sql`,`,
        )})`,
      );
    }
    if (query.meetingType) filters.push(sql`meeting_type=${enumQuery(query.meetingType, Object.keys(meetingNames))}`);
    const keyword = query.keyword?.trim().toLowerCase();
    if (keyword) {
      const names: SQL[] = [
        sql`instr(lower(title),${keyword})>0`,
        sql`EXISTS(SELECT 1 FROM ${role} rr WHERE rr.recruitment_id=${r.id} AND instr(lower(rr.name),${keyword})>0)`,
      ];
      for (const [key, label] of Object.entries(categoryNames))
        if (label.includes(keyword)) names.push(sql`category=${key}`);
      for (const [key, label] of Object.entries(meetingNames))
        if (label.includes(keyword)) names.push(sql`meeting_type=${key}`);
      filters.push(sql`(${sql.join(names, sql` OR `)})`);
    }
  }
  const where = sql.join(filters, sql` AND `);
  const total = await db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${r} WHERE ${where}`);
  const page = criteria(query.page, query.limit, total!.count);
  const rows = await db.all<Recruitment>(
    sql`SELECT * FROM ${r} WHERE ${where} ORDER BY ${sort === 'DEADLINE_ASC' ? sql`deadline_date ASC,id ASC` : sql`created_at DESC,id DESC`} LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const recruitments = await Promise.all(
    rows.map(async (value) => {
      const result = await card(db, value);
      if (authorId === undefined) return result;
      const [count, chat] = await Promise.all([
        db.get<{ count: number }>(
          sql`SELECT count(*) AS count FROM ${a} WHERE recruitment_id=${value.id} AND status IN ('PENDING','ACCEPTED')`,
        ),
        db.get<{ id: number }>(sql`SELECT id FROM ${room} WHERE recruitment_id=${value.id} AND room_scope_key='TEAM'`),
      ]);
      return {
        ...result,
        applicant_count: count!.count,
        can_close: value.status === 'RECRUITING',
        team_chat_available: Boolean(chat),
        team_chat_room_id: chat?.id ?? null,
      };
    }),
  );
  return {
    recruitments,
    total_count: page.total_count,
    current_count: rows.length,
    total_page: Math.ceil(page.total_count / page.limit),
    current_page: page.page,
  };
}
export async function createRecruitment(db: Database, userId: number, input: unknown) {
  const value = validateRecruitment(input);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([userId, value])));
  const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const guard = schema.native_team_request_guard;
  const existing = await db.get(sql`SELECT key FROM ${guard} WHERE key=${key} AND expires_at>${now}`);
  if (existing) throw new ApiError(409, 'REQUEST_TOO_FAST', '요청이 너무 빠릅니다. 다시 요청해주세요.');
  const id = sql`(SELECT recruitment_id FROM ${guard} WHERE key=${key})`;
  const statements = [
    assert(
      sql`EXISTS(SELECT 1 FROM ${schema.students} WHERE user_id=${userId}) AND NOT EXISTS(SELECT 1 FROM ${guard} WHERE key=${key} AND expires_at>${now})`,
    ),
    sql`INSERT INTO ${schema.team_recruitment_user_lock} (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`,
    sql`INSERT INTO ${guard} (key,expires_at) VALUES (${key},strftime('%Y-%m-%d %H:%M:%f','now','+0.3 seconds')) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at,recruitment_id=NULL`,
    sql`INSERT INTO ${r} (author_id,category,title,meeting_type,activity_start_date,activity_end_date,deadline_date,recruitment_type,max_participants,description,related_url,qualification) VALUES (${userId},${value.category},${value.title},${value.meeting_type},${value.activity_start_date},${value.activity_end_date},${value.deadline_date},${value.recruitment_type},${value.max_participants},${value.description},${value.related_url ?? null},${value.qualification ?? null})`,
    sql`UPDATE ${guard} SET recruitment_id=last_insert_rowid() WHERE key=${key}`,
    ...value.roles.map(
      (item, index) =>
        sql`INSERT INTO ${role} (recruitment_id,name,max_participants,display_order) VALUES (${id},${item.name},${item.max_participants},${index + 1})`,
    ),
    sql`INSERT INTO ${room} (recruitment_id,room_scope_key,room_type,status) VALUES (${id},'TEAM','TEAM','ACTIVE')`,
    sql`INSERT INTO ${member} (chat_room_id,user_id) VALUES (last_insert_rowid(),${userId})`,
    deadlineScheduleStatement(id),
    sql`SELECT recruitment_id AS id FROM ${guard} WHERE key=${key}`,
  ];
  const results = await atomic(db, statements, 'REQUEST_TOO_FAST');
  return results.at(-1)!.results[0] as { id: number };
}
export async function updateRecruitment(db: Database, id: number, userId: number, input: unknown) {
  const value = validateRecruitment(input);
  const snapshot = await frozenRecruitment(db, id);
  const old = await recruitment(db, id, userId);
  if (old.status !== 'RECRUITING') fail('TEAM_RECRUITMENT_CLOSED');
  const roles = await db.all<Role & { applicant_count: number }>(
    sql`SELECT rr.*,(SELECT count(*) FROM ${a} WHERE role_id=rr.id) AS applicant_count FROM ${role} rr WHERE recruitment_id=${id} ORDER BY display_order`,
  );
  const count = await db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${a} WHERE recruitment_id=${id}`);
  if (old.recruitment_type !== value.recruitment_type && count!.count > 0)
    fail('TEAM_RECRUITMENT_TYPE_CHANGE_NOT_ALLOWED');
  if (value.max_participants < old.current_participants) fail('TEAM_RECRUITMENT_MAX_PARTICIPANTS_BELOW_ACCEPTED');
  const existing = new Map(roles.map((item) => [item.id, item]));
  const kept: { old: Role; input: (typeof value.roles)[number] }[] = [];
  const added = value.roles.filter((item) => item.id == null);
  for (const item of value.roles) {
    if (item.id == null) continue;
    const previous = existing.get(item.id);
    if (!previous) fail('TEAM_RECRUITMENT_ROLE_NOT_FOUND');
    existing.delete(item.id);
    if (previous.applicant_count && (previous.name !== item.name || previous.max_participants > item.max_participants))
      fail('TEAM_RECRUITMENT_ROLE_UPDATE_NOT_ALLOWED');
    kept.push({ old: previous, input: item });
  }
  for (const item of existing.values()) if (item.applicant_count) fail('TEAM_RECRUITMENT_ROLE_UPDATE_NOT_ALLOWED');
  const statements: SQL[] = [
    snapshot,
    ...[...existing.values()].map((item) => sql`DELETE FROM ${role} WHERE id=${item.id}`),
  ];
  const reserved = new Set([...roles.map((item) => item.name), ...value.roles.map((item) => item.name)]);
  let candidate = 0;
  for (const item of kept)
    if (item.old.name !== item.input.name) {
      while (reserved.has('#' + candidate)) candidate++;
      const temporary = '#' + candidate++;
      reserved.add(temporary);
      statements.push(sql`UPDATE ${role} SET name=${temporary} WHERE id=${item.old.id}`);
    }
  kept.sort((left, right) => left.old.display_order - right.old.display_order);
  const highest = kept.at(-1)?.old.display_order ?? 0;
  const compact = highest + added.length > 5;
  for (const [index, item] of kept.entries())
    statements.push(
      sql`UPDATE ${role} SET name=${item.input.name},max_participants=${item.input.max_participants},display_order=${compact ? index + 1 : item.old.display_order},updated_at=${now} WHERE id=${item.old.id}`,
    );
  const start = compact ? kept.length + 1 : highest + 1;
  for (const [index, item] of added.entries())
    statements.push(
      sql`INSERT INTO ${role} (recruitment_id,name,max_participants,display_order) VALUES (${id},${item.name},${item.max_participants},${start + index})`,
    );
  statements.push(
    sql`UPDATE ${r} SET category=${value.category},title=${value.title},meeting_type=${value.meeting_type},activity_start_date=${value.activity_start_date},activity_end_date=${value.activity_end_date},deadline_date=${value.deadline_date},recruitment_type=${value.recruitment_type},max_participants=${value.max_participants},description=${value.description},related_url=${value.related_url ?? null},qualification=${value.qualification ?? null},status=CASE WHEN current_participants>=${value.max_participants} THEN 'CLOSED' ELSE 'RECRUITING' END,updated_at=${now} WHERE id=${id}`,
  );
  statements.push(
    ...closureStatements(
      db,
      id,
      'CAPACITY',
      sql`EXISTS(SELECT 1 FROM ${r} WHERE id=${id} AND current_participants>=max_participants)`,
    ),
  );
  statements.push(deadlineScheduleStatement(id));
  await atomic(db, statements);
  return detail(db, id, userId);
}
export async function closeRecruitment(db: Database, id: number, userId: number, deleted = false) {
  const snapshot = await frozenRecruitment(db, id);
  const value = await recruitment(db, id, userId, deleted);
  if (deleted ? value.status === 'DELETED' : value.status !== 'RECRUITING') return;
  await atomic(db, [
    snapshot,
    sql`UPDATE ${r} SET status=${deleted ? 'DELETED' : 'CLOSED'},deleted_at=${deleted ? now : sql`NULL`},updated_at=${now} WHERE id=${id}`,
    ...closureStatements(db, id, deleted ? 'DELETED' : 'CLOSED', sql`1`),
  ]);
}
export async function createApplication(db: Database, id: number, userId: number, input: unknown) {
  const value = parse(applicationInput, input);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['application', id, userId, value])),
  );
  const requestKey = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (
    await db.get(sql`SELECT key FROM ${schema.native_team_request_guard} WHERE key=${requestKey} AND expires_at>${now}`)
  )
    fail('REQUEST_TOO_FAST');
  const snapshot = await frozenRecruitment(db, id);
  const parent = await recruitment(db, id);
  if (parent.author_id === userId) fail('TEAM_RECRUITMENT_FORBIDDEN');
  if (parent.status !== 'RECRUITING' || parent.deadline_date < kstDay()) fail('TEAM_RECRUITMENT_CLOSED');
  if (await db.get(sql`SELECT id FROM ${a} WHERE recruitment_id=${id} AND applicant_id=${userId}`))
    fail('TEAM_RECRUITMENT_APPLICATION_DUPLICATE');
  const p = await getProfile(db, userId, 'TEAM_RECRUITMENT_PROFILE_REQUIRED');
  if (!p.department || !p.student_number || !/^\d{4}/.test(p.student_number)) fail('TEAM_RECRUITMENT_PROFILE_REQUIRED');
  if (!/^\d{8,10}$/.test(p.student_number)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '학생의 학번 형식이 아닙니다.');
  const academic = await db.get<{ valid: number }>(
    sql`SELECT NOT EXISTS(SELECT 1 FROM ${schema.academic_program_year} WHERE student_year=${p.student_number.slice(0, 4)}) OR EXISTS(SELECT 1 FROM ${schema.academic_program_year} y JOIN ${schema.students} s ON s.department_id=y.department_id WHERE s.user_id=${userId} AND y.student_year=${p.student_number.slice(0, 4)}) AS valid`,
  );
  if (!academic?.valid) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '학생의 전공 형식이 아닙니다.');
  let selected: Role | undefined;
  if (parent.recruitment_type === 'GENERAL') {
    if (value.role_id !== null) fail('INVALID_REQUEST_BODY');
  } else {
    if (value.role_id === null) fail('INVALID_REQUEST_BODY');
    selected = await db.get<Role>(sql`SELECT * FROM ${role} WHERE id=${value.role_id} AND recruitment_id=${id}`);
    if (!selected || selected.current_participants >= selected.max_participants) fail('TEAM_RECRUITMENT_ROLE_CLOSED');
  }
  if (parent.current_participants >= parent.max_participants) fail('TEAM_RECRUITMENT_CAPACITY_FULL');
  const savedSnapshot = JSON.stringify({
    nickname: p.profile_nickname,
    department: p.department,
    student_year: Number(p.student_number.slice(0, 4)),
    preferred_role: p.preferred_role,
    skills: p.skills,
    activities: p.activities,
    self_introduction: p.self_introduction,
  });
  const applicationId = sql`(SELECT id FROM ${a} WHERE recruitment_id=${id} AND applicant_id=${userId})`;
  const statements = [
    snapshot,
    assert(
      sql`EXISTS(SELECT 1 FROM ${schema.students} WHERE user_id=${userId}) AND EXISTS(SELECT 1 FROM ${profile} WHERE user_id=${userId}) AND EXISTS(SELECT 1 FROM ${r} WHERE id=${id} AND deadline_date>=date('now','+9 hours'))`,
    ),
    sql`INSERT INTO ${schema.native_team_request_guard} (key,expires_at) VALUES (${requestKey},strftime('%Y-%m-%d %H:%M:%f','now','+0.3 seconds')) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at`,
    sql`INSERT INTO ${schema.team_recruitment_user_lock} (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`,
    sql`INSERT INTO ${a} (recruitment_id,applicant_id,role_id,motivation,availability,profile_snapshot) VALUES (${id},${userId},${value.role_id},${value.motivation},${value.availability},${savedSnapshot})`,
    ...notificationStatements(
      db,
      {
        eventKey: sql`'team-recruitment:application:' || ${applicationId} || ':NEW_APPLICATION'`,
        type: 'NEW_APPLICATION',
        targetType: 'APPLICANT_MANAGEMENT',
        recipientId: parent.author_id!,
        recruitmentId: id,
        applicationId,
        chatRoomId: null,
        messagePreview: (parent.title + '에 새로운 지원자가 있어요.').slice(0, 255),
      },
      sql`1`,
    ),
  ];
  statements.push(sql`SELECT * FROM ${a} WHERE recruitment_id=${id} AND applicant_id=${userId}`);
  const results = await atomic(db, statements, 'TEAM_RECRUITMENT_APPLICATION_DUPLICATE');
  const created = results.at(-1)!.results[0] as Application;
  return {
    application_id: created!.id,
    recruitment_id: id,
    status: created!.status,
    role: selected ? { id: selected.id, name: selected.name } : null,
    created_at: new Date(Date.parse(created!.created_at.replace(' ', 'T') + 'Z') + 9 * 3_600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19),
  };
}
export async function decideApplication(
  db: Database,
  id: number,
  applicationId: number,
  userId: number,
  input: unknown,
) {
  const status = (input as { status?: unknown } | null)?.status;
  if (status !== 'ACCEPTED' && status !== 'REJECTED') fail('INVALID_REQUEST_BODY');
  const snapshot = await frozenRecruitment(db, id);
  const parent = await recruitment(db, id, userId);
  if (parent.status !== 'RECRUITING' || parent.deadline_date < kstDay()) fail('TEAM_RECRUITMENT_CLOSED');
  const application = await db.get<Application>(
    sql`SELECT * FROM ${a} WHERE id=${applicationId} AND recruitment_id=${id}`,
  );
  if (!application) fail('TEAM_RECRUITMENT_APPLICATION_NOT_FOUND');
  if (application.applicant_id === null || application.status !== 'PENDING')
    fail('TEAM_RECRUITMENT_APPLICATION_FINALIZED');
  const selected =
    application.role_id === null
      ? null
      : await db.get<Role>(sql`SELECT * FROM ${role} WHERE id=${application.role_id} AND recruitment_id=${id}`);
  if (status === 'ACCEPTED') {
    if (parent.current_participants >= parent.max_participants) fail('TEAM_RECRUITMENT_CAPACITY_FULL');
    if (parent.recruitment_type !== 'GENERAL' && !selected) fail('TEAM_RECRUITMENT_APPLICATION_NOT_FOUND');
    if (selected && selected.current_participants >= selected.max_participants) fail('TEAM_RECRUITMENT_ROLE_CLOSED');
  }
  const teamRoom = sql`(SELECT id FROM ${room} WHERE recruitment_id=${id} AND room_scope_key='TEAM')`;
  const statements: SQL[] = [
    snapshot,
    assert(sql`EXISTS(SELECT 1 FROM ${r} WHERE id=${id} AND deadline_date>=date('now','+9 hours'))`),
  ];
  if (status === 'ACCEPTED')
    statements.push(
      sql`INSERT INTO ${room} (recruitment_id,room_scope_key,room_type,status) VALUES (${id},'TEAM','TEAM','ACTIVE') ON CONFLICT(recruitment_id,room_scope_key) DO NOTHING`,
      sql`INSERT INTO ${member} (chat_room_id,user_id,last_read_message_id) SELECT ${teamRoom},u.id,(SELECT max(id) FROM ${schema.team_recruitment_chat_message} WHERE chat_room_id=${teamRoom}) FROM ${schema.users} u WHERE u.id IN (${parent.author_id},${application.applicant_id}) ON CONFLICT(chat_room_id,user_id) DO NOTHING`,
      sql`UPDATE ${r} SET current_participants=current_participants+1,updated_at=${now} WHERE id=${id}`,
      ...(selected
        ? [
            sql`UPDATE ${role} SET current_participants=current_participants+1,updated_at=${now} WHERE id=${selected.id}`,
          ]
        : []),
    );
  statements.push(
    sql`UPDATE ${a} SET status=${status},decision_reason=${status === 'REJECTED' ? 'APPLICATION_REJECTED' : null},updated_at=${now} WHERE id=${applicationId}`,
    ...notificationStatements(
      db,
      {
        eventKey: `team-recruitment:application:${applicationId}:APPLICATION_${status}`,
        type: `APPLICATION_${status}`,
        targetType: status === 'ACCEPTED' ? 'CHAT_ROOM' : 'MY_APPLICATIONS',
        recipientId: application.applicant_id,
        recruitmentId: id,
        applicationId,
        chatRoomId: status === 'ACCEPTED' ? teamRoom : null,
        messagePreview: (
          parent.title + (status === 'ACCEPTED' ? ' 지원이 승인되었어요.' : ' 지원이 거절되었어요.')
        ).slice(0, 255),
      },
      sql`1`,
    ),
  );
  if (status === 'ACCEPTED')
    statements.push(
      sql`UPDATE ${r} SET status='CLOSED',updated_at=${now} WHERE id=${id} AND current_participants>=max_participants`,
      ...closureStatements(
        db,
        id,
        'ACCEPTANCE_CAPACITY',
        sql`EXISTS(SELECT 1 FROM ${r} WHERE id=${id} AND current_participants>=max_participants)`,
      ),
    );
  await atomic(db, statements, 'TEAM_RECRUITMENT_APPLICATION_FINALIZED');
}

async function applicationView(db: Database, application: Application, parent: Recruitment) {
  const [selected, team, direct] = await Promise.all([
    application.role_id === null
      ? null
      : db.get<{ id: number; name: string }>(sql`SELECT id,name FROM ${role} WHERE id=${application.role_id}`),
    db.get<{ id: number }>(
      sql`SELECT id FROM ${room} WHERE recruitment_id=${parent.id} AND room_scope_key='TEAM' AND room_type='TEAM'`,
    ),
    application.status !== 'ACCEPTED'
      ? null
      : db.get<{ id: number }>(
          sql`SELECT id FROM ${room} WHERE application_id=${application.id} AND room_type='DIRECT'`,
        ),
  ]);
  const snapshot =
    typeof application.profile_snapshot === 'string'
      ? (JSON.parse(application.profile_snapshot) as Record<string, unknown>)
      : (application.profile_snapshot as Record<string, unknown>);
  if (application.applicant_id === null) snapshot.nickname = '탈퇴한 회원';
  const canOpen =
    application.applicant_id !== null &&
    application.status === 'ACCEPTED' &&
    (Boolean(direct) ||
      (parent.status !== 'DELETED' &&
        (parent.status === 'RECRUITING'
          ? parent.deadline_date >= kstDay()
          : parent.status === 'CLOSED' && Boolean(team))));
  return { snapshot, selected: selected ?? null, team, direct, canOpen };
}
export async function listApplications(db: Database, query: Query, userId: number, recruitmentId?: number) {
  const statuses = query.statuses
    ? query.statuses.split(',').filter(Boolean)
    : ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
  for (const status of statuses) enumQuery(status, ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED']);
  const filter = sql`${recruitmentId === undefined ? sql`applicant_id=${userId}` : sql`recruitment_id=${recruitmentId}`} AND status IN (${sql.join(
    statuses.map((value) => sql`${value}`),
    sql`,`,
  )})`;
  const parent = recruitmentId === undefined ? null : await recruitment(db, recruitmentId, userId);
  const count = await db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${a} WHERE ${filter}`);
  const page = criteria(query.page, query.limit, count!.count);
  const sort = enumQuery(query.sort, ['LATEST_DESC', 'DEADLINE_ASC'], 'LATEST_DESC');
  const rows = await db.all<Application>(
    sql`SELECT * FROM ${a} WHERE ${filter} ORDER BY ${recruitmentId === undefined && sort === 'DEADLINE_ASC' ? sql`(SELECT deadline_date FROM ${r} WHERE id=${a.recruitment_id}) ASC,created_at DESC,id DESC` : sql`created_at DESC,id DESC`} LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const applications = await Promise.all(
    rows.map(async (application) => {
      const post = parent ?? (await recruitment(db, application.recruitment_id, undefined, true));
      const view = await applicationView(db, application, post);
      if (parent)
        return {
          application_id: application.id,
          nickname: view.snapshot.nickname,
          department: view.snapshot.department,
          student_year: view.snapshot.student_year,
          role: view.selected,
          status: application.status,
          can_open_direct_chat: view.canOpen,
        };
      if (application.status === 'ACCEPTED' && !view.team)
        throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '승인된 지원서의 팀 채팅방이 존재하지 않습니다.');
      return {
        application_id: application.id,
        status: application.status,
        team_chat_available: application.status === 'ACCEPTED' && Boolean(view.team),
        team_chat_room_id: application.status === 'ACCEPTED' ? (view.team?.id ?? null) : null,
        direct_chat_room_id: view.direct?.id ?? null,
        role: view.selected,
        recruitment: await card(db, post, true),
      };
    }),
  );
  const result = {
    applications,
    total_count: page.total_count,
    current_count: applications.length,
    total_page: page.total_page,
    current_page: page.page,
  };
  if (!parent) return result;
  const chat = await db.get<{ id: number }>(
    sql`SELECT id FROM ${room} WHERE recruitment_id=${parent.id} AND room_scope_key='TEAM' AND room_type='TEAM'`,
  );
  return {
    recruitment: {
      ...(await card(db, parent, true)),
      team_chat_available: Boolean(chat),
      team_chat_room_id: chat?.id ?? null,
    },
    ...result,
  };
}
export async function applicationDetail(db: Database, id: number, applicationId: number, userId: number) {
  const parent = await recruitment(db, id, userId);
  const application = await db.get<Application>(
    sql`SELECT * FROM ${a} WHERE id=${applicationId} AND recruitment_id=${id}`,
  );
  if (!application) fail('TEAM_RECRUITMENT_APPLICATION_NOT_FOUND');
  const view = await applicationView(db, application, parent);
  return {
    application_id: application.id,
    status: application.status,
    profile_snapshot: view.snapshot,
    motivation: application.motivation,
    availability: application.availability,
    role: view.selected,
    can_decide:
      application.applicant_id !== null &&
      application.status === 'PENDING' &&
      parent.status === 'RECRUITING' &&
      parent.deadline_date >= kstDay(),
    can_open_direct_chat: view.canOpen,
  };
}
export async function buildTeamWithdrawal(db: Database, userId: number): Promise<SQL[]> {
  return [
    sql`INSERT INTO ${schema.team_recruitment_user_lock} (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`,
    sql`UPDATE ${role} SET current_participants=current_participants-(SELECT count(*) FROM ${a} WHERE role_id=${role.id} AND applicant_id=${userId} AND status='ACCEPTED'),updated_at=${now} WHERE EXISTS(SELECT 1 FROM ${a} WHERE role_id=${role.id} AND applicant_id=${userId} AND status='ACCEPTED')`,
    sql`UPDATE ${r} SET current_participants=current_participants-(SELECT count(*) FROM ${a} WHERE recruitment_id=${r.id} AND applicant_id=${userId} AND status='ACCEPTED'),updated_at=${now} WHERE EXISTS(SELECT 1 FROM ${a} WHERE recruitment_id=${r.id} AND applicant_id=${userId} AND status='ACCEPTED')`,
    sql`UPDATE ${a} SET status='CANCELLED',decision_reason='USER_WITHDRAWN',updated_at=${now} WHERE applicant_id=${userId} AND status='PENDING'`,
    sql`UPDATE ${a} SET status='REJECTED',decision_reason='RECRUITMENT_CLOSED',updated_at=${now} WHERE status='PENDING' AND recruitment_id IN (SELECT id FROM ${r} WHERE author_id=${userId} AND status='RECRUITING')`,
    sql`UPDATE ${r} SET status='CLOSED',updated_at=${now} WHERE author_id=${userId} AND status='RECRUITING'`,
    sql`DELETE FROM ${schema.team_recruitment_outbox_event} WHERE status<>'PUBLISHED' AND CAST(json_extract(payload,'$.recipient_id') AS INTEGER)=${userId}`,
  ];
}
