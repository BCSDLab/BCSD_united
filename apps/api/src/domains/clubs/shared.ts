import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { requirePrincipal } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';
import { integer, localDateTime, sqlNow, text } from '@api/domains/clubs/behavior';

export type Club = typeof schema.club.$inferSelect;
export const snsTypes = {
  instagram: 'INSTAGRAM',
  google_form: 'GOOGLE_FORM',
  open_chat: 'OPEN_CHAT',
  phone_number: 'PHONE_NUMBER',
} as const;
export const snsLabels: Record<string, string> = {
  INSTAGRAM: '인스타그램',
  GOOGLE_FORM: '구글 폼',
  OPEN_CHAT: '오픈 채팅',
  PHONE_NUMBER: '전화 번호',
};

export function missing(message = '동아리가 존재하지 않습니다.'): never {
  throw new ApiError(404, 'NOT_FOUND', message);
}

export function forbidden(): never {
  throw new ApiError(403, 'FORBIDDEN', '권한이 없습니다.');
}

export function clubId(c: Context<ApiEnv>): number {
  return integer(c.req.param('clubId'), 'clubId');
}

export async function getClub(db: Database, id: number): Promise<Club> {
  const [club] = await db.select().from(schema.club).where(eq(schema.club.id, id)).limit(1);
  if (!club) throw new ApiError(404, 'NOT_FOUND_CLUB', '동아리가 존재하지 않습니다.');
  return club;
}

export async function getCategory(db: Database, id: number) {
  const [category] = await db.select().from(schema.club_category).where(eq(schema.club_category.id, id)).limit(1);
  return category ?? missing('동아리 카테고리가 존재하지 않습니다.');
}

export async function getUser(db: Database, id: number) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.is_deleted, false)))
    .limit(1);
  if (!user) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
  return user;
}

export async function manager(db: Database, id: number, user: number | null): Promise<boolean> {
  if (user === null) return false;
  const rows = await db
    .select({ id: schema.club_manager.id })
    .from(schema.club_manager)
    .where(and(eq(schema.club_manager.club_id, id), eq(schema.club_manager.user_id, user)))
    .limit(1);
  return rows.length > 0;
}

export async function requireManager(c: Context<ApiEnv>, id = clubId(c)) {
  const principal = requirePrincipal(c, ['STUDENT']);
  const club = await getClub(c.get('db'), id);
  if (!(await manager(c.get('db'), id, principal.id))) forbidden();
  return { club, userId: principal.id };
}

export async function requireStudent(c: Context<ApiEnv>): Promise<number> {
  const id = requirePrincipal(c, ['STUDENT']).id;
  const [student] = await c
    .get('db')
    .select({ id: schema.students.user_id })
    .from(schema.students)
    .where(eq(schema.students.user_id, id))
    .limit(1);
  if (!student) missing('학생이 존재하지 않습니다.');
  return id;
}

export async function body(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', '올바른 JSON 형식이 아닙니다.');
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new ApiError(400, 'INVALID_REQUEST', '요청 본문이 올바르지 않습니다.');
  return value as Record<string, unknown>;
}

export function contactsSql(id: number | SQL, contacts: Record<string, string | null>, skipBlank: boolean): SQL[] {
  return Object.entries(snsTypes).flatMap(([key, type]) => {
    const contact = contacts[key];
    return contact == null || (skipBlank && !contact.trim())
      ? []
      : [sql`INSERT INTO ${schema.club_sns} (club_id,sns_type,contact) VALUES (${id},${type},${contact})`];
  });
}

export function outboxSql(
  kind: string,
  payload: Record<string, unknown>,
  key = crypto.randomUUID(),
  dueAt = sqlNow(),
): SQL {
  return sql`INSERT INTO ${schema.native_club_outbox} (id,kind,payload,due_at) VALUES (${key},${kind},${JSON.stringify(payload)},${dueAt}) ON CONFLICT(id) DO NOTHING`;
}

export async function signalClubJobs(env: Bindings, ids: readonly string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 100) {
    await env.JOBS.sendBatch(
      ids.slice(offset, offset + 100).map((id) => ({ body: { kind: 'clubs.outbox', key: id, payload: {} } })),
    );
  }
}

export async function clubResponse(db: Database, club: Club, userId: number | null, includeHot = false) {
  const category = await getCategory(db, club.club_category_id);
  const contacts = await db.select().from(schema.club_sns).where(eq(schema.club_sns.club_id, club.id));
  const isManager = await manager(db, club.id, userId);
  const liked =
    userId === null
      ? []
      : await db
          .select({ id: schema.club_like.id })
          .from(schema.club_like)
          .where(and(eq(schema.club_like.club_id, club.id), eq(schema.club_like.user_id, userId)))
          .limit(1);
  const subscribed =
    userId === null
      ? []
      : await db
          .select({ id: schema.club_recruitment_subscription.id })
          .from(schema.club_recruitment_subscription)
          .where(
            and(
              eq(schema.club_recruitment_subscription.club_id, club.id),
              eq(schema.club_recruitment_subscription.user_id, userId),
            ),
          )
          .limit(1);
  let hotStatus: { month: number; week_of_month: number; streak_count: number } | null = null;
  if (includeHot) {
    const hot = await db
      .select()
      .from(schema.club_hot)
      .orderBy(sql`${schema.club_hot.id} DESC`);
    const last = hot.find((item) => item.club_id === club.id);
    if (last) {
      let streak = 0;
      // 최신 주부터 연속으로 이 동아리가 1위였던 주 수.
      for (const entry of hot) {
        if (entry.club_id !== club.id) break;
        streak++;
      }
      hotStatus = {
        month: Number(last.start_date.slice(5, 7)),
        week_of_month: Math.floor((Number(last.start_date.slice(8, 10)) - 1) / 7) + 1,
        streak_count: streak,
      };
    }
  }
  return {
    id: club.id,
    name: club.name,
    category: category.name,
    location: club.location,
    image_url: club.image_url,
    likes: club.likes,
    description: club.description,
    introduction: club.introduction,
    ...Object.fromEntries(
      Object.entries(snsTypes).map(([key, type]) => [
        key,
        contacts.find((contact) => contact.sns_type === type)?.contact ?? null,
      ]),
    ),
    manager: isManager,
    is_liked: liked.length > 0,
    is_recruit_subscribed: subscribed.length > 0,
    updated_at: `${localDateTime(club.updated_at).slice(0, 10).replaceAll('-', '.')}.`,
    is_like_hidden: club.is_like_hidden,
    hot_status: hotStatus,
  };
}

export async function managersByLogin(db: Database, input: unknown): Promise<number[]> {
  if (!Array.isArray(input)) throw new ApiError(400, 'INVALID_REQUEST', '동아리 관리자는 필수 입력 사항입니다.');
  const ids: number[] = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '동아리 관리자 입력값이 올바르지 않습니다.');
    const login = text(entry, 'user_id', 255, true)!;
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.user_id, login), eq(schema.users.is_deleted, false)))
      .limit(1);
    if (!user) missing('사용자가 존재하지 않습니다.');
    ids.push(user.id);
  }
  return ids;
}

export async function createClub(
  db: Database,
  data: {
    name: string;
    normalized_name: string;
    image_url: string;
    club_category_id: number;
    location: string;
    description: string | null;
    is_like_hidden: boolean;
    contacts: Record<string, string | null>;
  },
  managers: number[],
  active: boolean,
  extra: SQL[] = [],
) {
  await getCategory(db, data.club_category_id);
  const id = sql`(SELECT MAX(id) FROM ${schema.club})`;
  await executeAtomic(db, [
    sql`INSERT INTO ${schema.club} (name,normalized_name,image_url,club_category_id,location,description,is_like_hidden,is_active,hits,likes,last_week_hits,introduction) VALUES (${data.name},${data.normalized_name},${data.image_url},${data.club_category_id},${data.location},${data.description ?? ''},${data.is_like_hidden},${active},0,0,0,'')`,
    ...managers.map((user) => sql`INSERT INTO ${schema.club_manager} (club_id,user_id) VALUES (${id},${user})`),
    ...contactsSql(id, data.contacts, false),
    ...extra,
  ]);
}
