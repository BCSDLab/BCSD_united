import { sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';

export type Post = typeof schema.callvan_post.$inferSelect;
export type Participant = typeof schema.callvan_participant.$inferSelect;
export type Notification = typeof schema.callvan_notification.$inferSelect;
export type Report = typeof schema.callvan_report.$inferSelect;
export type User = typeof schema.users.$inferSelect;
export type ProcessType = 'WARNING' | 'TEMPORARY_RESTRICTION_14_DAYS' | 'PERMANENT_RESTRICTION' | 'REJECT';
export type EventType = 'PARTICIPANT_JOINED' | 'RECRUITMENT_COMPLETE' | 'NEW_MESSAGE' | 'DEPARTURE_UPCOMING' | 'REPORT_WARNING' | 'REPORT_RESTRICTION_14_DAYS' | 'REPORT_PERMANENT_RESTRICTION';
export interface EventPayload { sender_id?: number; sender_nickname?: string; content?: string; is_image?: boolean; recipient_id?: number }

const errors = {
  INVALID_REQUEST_BODY: [400, '잘못된 입력값이 포함되어 있습니다.'],
  INVALID_CUSTOM_LOCATION_NAME: [400, '기타 장소명이 올바르지 않습니다.'],
  CALLVAN_POST_NOT_RECRUITING: [400, '모집 중인 게시글이 아닙니다.'],
  CALLVAN_POST_FULL: [400, '참여 인원이 가득 찼습니다.'],
  CALLVAN_POST_REOPEN_FAILED_FULL: [400, '인원이 가득 차서 모집을 다시 열 수 없습니다.'],
  CALLVAN_POST_REOPEN_FAILED_TIME: [400, '출발 시간이 지나서 모집을 다시 열 수 없습니다.'],
  CALLVAN_POST_JOIN_FAILED_TIME: [400, '출발 시간이 지나서 참여할 수 없습니다.'],
  CALLVAN_POST_AUTHOR: [400, '콜벤 게시글 작성자는 나갈 수 없습니다'],
  CALLVAN_REPORT_SELF: [400, '자기 자신은 신고할 수 없습니다.'],
  CALLVAN_REPORT_ALREADY_PROCESSED: [400, '이미 처리된 콜벤 신고입니다.'],
  UNAUTHORIZED_USER: [401, '인증이 필요합니다.'],
  FORBIDDEN_AUTHOR: [403, '게시글 접근 권한이 없습니다.'],
  FORBIDDEN_PARTICIPANT: [403, '콜벤 게시글 참여자가 아닙니다.'],
  CALLVAN_REPORT_ONLY_PARTICIPANT: [403, '같은 콜벤팟 참여자만 신고할 수 있습니다.'],
  FORBIDDEN_CALLVAN_RESTRICTED_USER: [403, '콜벤 기능 이용이 제한된 사용자입니다.'],
  NOT_FOUND_USER: [404, '사용자가 존재하지 않습니다.'],
  NOT_FOUND_ARTICLE: [404, '게시글이 존재하지 않습니다.'],
  NOT_FOUND_CALLVAN_REPORT: [404, '콜벤 신고 내역을 찾을 수 없습니다.'],
  CALLVAN_ALREADY_JOINED: [409, '이미 참여한 게시글입니다.'],
  CALLVAN_REPORT_ALREADY_PENDING: [409, '이미 접수된 신고가 있어 추가 신고할 수 없습니다.'],
} as const;

export function fail(code: keyof typeof errors): never {
  const [status, message] = errors[code];
  throw new ApiError(status, code, message);
}

export const locations = {
  FRONT_GATE: '정문', BACK_GATE: '후문', TENNIS_COURT: '테니스장', DORMITORY_MAIN: '본관동',
  DORMITORY_SUB: '별관동', TERMINAL: '천안터미널', STATION: '천안역', ASAN_STATION: '천안아산역', CUSTOM: 'CUSTOM',
} as const;

export function locationName(type: string | null, name: string | null): string {
  return name?.trim() ? name : locations[type as keyof typeof locations] ?? '';
}

export function displayNickname(user: Pick<User, 'nickname' | 'anonymous_nickname'>): string {
  return user.nickname?.trim() ? user.nickname : user.anonymous_nickname?.trim() ? user.anonymous_nickname : '익명 사용자';
}

export function utcText(now = Date.now()): string {
  return new Date(now).toISOString().replace('T', ' ').slice(0, 23);
}

function kstText(now = Date.now()): string {
  return utcText(now + 9 * 60 * 60 * 1000);
}

export function localDateTime(value: string | null): string | null {
  if (!value) return null;
  return kstText(Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')).replace(' ', 'T').replace(/\.000$/, '');
}

export function departureMillis(post: Pick<Post, 'departure_date' | 'departure_time'>): number {
  return Date.parse(`${post.departure_date}T${post.departure_time}+09:00`);
}

export function reminderTime(post: Pick<Post, 'departure_date' | 'departure_time'>, now: number): string | null {
  const due = departureMillis(post) - 30 * 60 * 1000;
  return due > now ? utcText(due) : null;
}

export function assertJoinable(post: Pick<Post, 'status' | 'departure_date' | 'departure_time' | 'current_participants' | 'max_participants'>, now: number): void {
  if (post.status !== 'RECRUITING') fail('CALLVAN_POST_NOT_RECRUITING');
  if (departureMillis(post) <= now) fail('CALLVAN_POST_JOIN_FAILED_TIME');
  if (post.current_participants >= post.max_participants) fail('CALLVAN_POST_FULL');
}

export function assertReopenable(post: Pick<Post, 'departure_date' | 'departure_time' | 'current_participants' | 'max_participants'>, now: number): void {
  if (post.current_participants >= post.max_participants) fail('CALLVAN_POST_REOPEN_FAILED_FULL');
  if (departureMillis(post) <= now) fail('CALLVAN_POST_REOPEN_FAILED_TIME');
}

export function pagination(page: number | undefined, limit: number | undefined, total: number) {
  const size = Math.max(1, Math.min(50, limit ?? 10));
  const pages = Math.ceil(total / size);
  const current = Math.max(1, Math.min(page ?? 1, Math.max(1, pages)));
  return { limit: size, page: current, pages, offset: (current - 1) * size };
}

export function integer(value: unknown): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result)) fail('INVALID_REQUEST_BODY');
  return result;
}

export function queryInteger(c: Context<ApiEnv>, key: string): number | undefined {
  const value = c.req.query(key);
  return value === undefined ? undefined : integer(value);
}

export function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('INVALID_REQUEST_BODY');
  return value as T;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST_BODY');
  return value as Record<string, unknown>;
}

export async function body(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  try {
    return object(await c.req.json());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return fail('INVALID_REQUEST_BODY');
  }
}

export interface CreatePostInput {
  departure_type: keyof typeof locations; departure_custom_name: string;
  arrival_type: keyof typeof locations; arrival_custom_name: string;
  departure_date: string; departure_time: string; max_participants: number;
}

export function createInput(value: Record<string, unknown>): CreatePostInput {
  const departure = enumeration(value.departure_type, Object.keys(locations) as (keyof typeof locations)[]);
  const arrival = enumeration(value.arrival_type, Object.keys(locations) as (keyof typeof locations)[]);
  const name = (type: keyof typeof locations, custom: unknown) => {
    if (custom != null && typeof custom !== 'string') fail('INVALID_REQUEST_BODY');
    const text = custom as string | null | undefined;
    if (type === 'CUSTOM' ? !text?.trim() : !!text?.trim()) fail('INVALID_CUSTOM_LOCATION_NAME');
    if (text && text.length > 50) fail('INVALID_REQUEST_BODY');
    return type === 'CUSTOM' ? text! : locations[type];
  };
  const date = value.departure_date;
  const time = value.departure_time;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('INVALID_REQUEST_BODY');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('INVALID_REQUEST_BODY');
  const max = integer(value.max_participants);
  if (max < 2 || max > 11) fail('INVALID_REQUEST_BODY');
  const from = name(departure, value.departure_custom_name);
  const to = name(arrival, value.arrival_custom_name);
  if (`${from} -> ${to}`.length > 100 || `${from} -> ${to} ${time}`.length > 100) fail('INVALID_REQUEST_BODY');
  return { departure_type: departure, departure_custom_name: from, arrival_type: arrival, arrival_custom_name: to, departure_date: date, departure_time: `${time}:00`, max_participants: max };
}

export function gate(key: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.native_callvan_guard} WHERE id = ${key})`;
}
export function guardedId(key: string): SQL {
  return sql`(SELECT entity_id FROM ${schema.native_callvan_guard} WHERE id = ${key})`;
}
export function beginGuard(key: string, condition: SQL, entityId: number | null = null): SQL {
  return sql`INSERT INTO ${schema.native_callvan_guard} (id, entity_id) SELECT ${key}, ${entityId} WHERE ${condition}`;
}
export function endGuard(key: string): SQL {
  return sql`DELETE FROM ${schema.native_callvan_guard} WHERE id = ${key}`;
}
export function activeParticipant(postId: number | SQL, userId: number): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.callvan_participant} WHERE post_id = ${postId} AND member_id = ${userId} AND is_deleted = 0)`;
}
export function restrictionCondition(userId: number, now: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.callvan_report_process} rp JOIN ${schema.callvan_report} r ON r.id = rp.report_id WHERE r.reported_id = ${userId} AND r.is_deleted = 0 AND rp.is_deleted = 0 AND (rp.process_type = 'PERMANENT_RESTRICTION' OR (rp.process_type = 'TEMPORARY_RESTRICTION_14_DAYS' AND julianday(rp.restricted_until) >= julianday(${now}))))`;
}
export async function assertNotRestricted(db: Database, userId: number, now = utcText()): Promise<void> {
  const row = await db.get<{ restricted: number }>(sql`SELECT ${restrictionCondition(userId, now)} AS restricted`);
  if (row?.restricted) fail('FORBIDDEN_CALLVAN_RESTRICTED_USER');
}
export async function getPost(db: Database, postId: number): Promise<Post> {
  const post = await db.get<Post>(sql`SELECT * FROM ${schema.callvan_post} WHERE id = ${postId} AND is_deleted = 0`);
  if (!post) fail('NOT_FOUND_ARTICLE');
  return post;
}
export async function getUser(db: Database, userId: number): Promise<User> {
  const user = await db.get<User>(sql`SELECT * FROM ${schema.users} WHERE id = ${userId} AND is_deleted = 0`);
  if (!user) fail('NOT_FOUND_USER');
  return user;
}
export async function requireParticipant(db: Database, postId: number, userId: number): Promise<void> {
  const row = await db.get<{ present: number }>(sql`SELECT ${activeParticipant(postId, userId)} AS present`);
  if (!row?.present) fail('FORBIDDEN_PARTICIPANT');
}

export function eventStatement(key: string, eventId: string, postId: number | SQL, type: EventType, payload: EventPayload, now: string, due = now, extra: SQL = sql`1`): SQL {
  return sql`INSERT INTO ${schema.native_callvan_event} (id, post_id, type, payload, available_at, created_at) SELECT ${eventId}, ${postId}, ${type}, ${JSON.stringify(payload)}, ${due}, ${now} WHERE ${gate(key)} AND ${extra}`;
}

export function queueDelaySeconds(availableAt: string, now = Date.now()): number {
  const due = Date.parse(availableAt.replace(' ', 'T') + 'Z');
  return Math.max(0, Math.min(43_200, Math.ceil((due - now) / 1000)));
}

export async function signalEvents(env: Bindings, ids: string[], availableAt?: string): Promise<void> {
  for (const id of ids) await env.JOBS.send(
    { kind: 'callvan.event', key: id, payload: {} },
    { delaySeconds: availableAt ? queueDelaySeconds(availableAt) : 0 },
  );
}

export function summary(post: Post & { author_nickname: string | null; joined: number }, userId: number | null) {
  return { id: post.id, title: post.title, departure: locationName(post.departure_type, post.departure_custom_name), arrival: locationName(post.arrival_type, post.arrival_custom_name), departure_date: post.departure_date, departure_time: post.departure_time.slice(0, 5), author_nickname: post.author_nickname, current_participants: post.current_participants, max_participants: post.max_participants, status: post.status, is_joined: Boolean(post.joined), is_author: post.author_id === userId };
}
