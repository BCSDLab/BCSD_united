import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';
import {
  outboxConfiguration,
  TEAM_NOTIFICATION_JOB,
  TEAM_DEADLINE_JOB,
  deadlineDelaySeconds,
} from '@api/domains/team/jobs';
import { coordinateRequest } from '@api/coordination';

const rooms = schema.team_recruitment_chat_room;
const members = schema.team_recruitment_chat_member;
const messages = schema.team_recruitment_chat_message;
const recruitments = schema.team_recruitment;
const applications = schema.team_recruitment_application;
const profiles = schema.team_recruitment_profile;
const notifications = schema.team_recruitment_notification;
const outbox = schema.team_recruitment_outbox_event;

export type NotificationType =
  | 'NEW_APPLICATION'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REJECTED'
  | 'RECRUITMENT_CLOSED'
  | 'RECRUITMENT_DELETED'
  | 'NEW_CHAT_MESSAGE';
export type NotificationInput = {
  eventKey: string | SQL;
  type: NotificationType;
  targetType: string | SQL;
  recipientId: number | SQL;
  recruitmentId: number | SQL;
  applicationId?: number | SQL | null;
  chatRoomId?: number | SQL | null;
  messagePreview: string | SQL;
  senderNickname?: string | SQL | null;
};

export function notificationStatements(db: Database, input: NotificationInput, guard: SQL = sql`1`) {
  return [
    sql`INSERT INTO ${notifications}
      (native_event_key, recipient_id, type, target_type, message_preview, sender_nickname, recruitment_id, application_id, chat_room_id)
      SELECT ${input.eventKey}, ${input.recipientId}, ${input.type}, ${input.targetType}, ${input.messagePreview},
        ${input.senderNickname ?? null}, ${input.recruitmentId}, ${input.applicationId ?? null}, ${input.chatRoomId ?? null}
      WHERE (${guard}) AND NOT EXISTS (SELECT 1 FROM ${outbox} WHERE event_key = ${input.eventKey})
      ON CONFLICT(native_event_key) DO NOTHING`,
    outboxStatement(db, sql`n.native_event_key = ${input.eventKey} AND (${guard})`),
  ];
}

export function deadlineScheduleStatement(recruitmentId: number | SQL): SQL {
  return sql`INSERT INTO ${outbox} (event_key, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, next_attempt_at)
    SELECT 'team-recruitment:deadline:' || id || ':' || deadline_date, 'TEAM_RECRUITMENT_DEADLINE', 'TEAM_RECRUITMENT', id,
      json_object('recruitment_id', id, 'deadline_date', deadline_date), 'PENDING', 0, datetime(deadline_date, '+1 day', '-9 hours')
    FROM ${recruitments} WHERE id = ${recruitmentId} AND status = 'RECRUITING' AND deadline_date IS NOT NULL
    ON CONFLICT(event_key) DO UPDATE SET status = 'PENDING', next_attempt_at = excluded.next_attempt_at,
      attempt_count = 0, worker_id = NULL, locked_until = NULL, published_at = NULL, last_error = NULL
    WHERE ${outbox}.status = 'PUBLISHED'`;
}

export async function signalTeamNotifications(env: Bindings, recruitmentId: number): Promise<void> {
  const config = outboxConfiguration(env);
  const db = createDatabase(env.DB);
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const ready = await db.all<{ event_key: string; event_type: string; next_attempt_at: string | null }>(sql`
    SELECT event_key, event_type, next_attempt_at FROM ${outbox}
    WHERE aggregate_type = 'TEAM_RECRUITMENT' AND aggregate_id = ${recruitmentId}
      AND ((event_type = 'TEAM_RECRUITMENT_DEADLINE' AND status = 'PENDING')
        OR (${Number(config.enabled)} = 1 AND event_type = 'TEAM_RECRUITMENT_NOTIFICATION'
          AND status IN ('PENDING', 'FAILED') AND attempt_count < ${config.maxAttempts}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))) ORDER BY id`);
  for (const event of ready) {
    const deadline = event.event_type === 'TEAM_RECRUITMENT_DEADLINE';
    await env.JOBS.send(
      { kind: deadline ? TEAM_DEADLINE_JOB : TEAM_NOTIFICATION_JOB, key: event.event_key, payload: {} },
      deadline ? { delaySeconds: deadlineDelaySeconds(event.next_attempt_at!, Date.now()) } : undefined,
    );
  }
}

function outboxStatement(db: Database, predicate: SQL) {
  return sql`INSERT INTO ${outbox} (event_key, event_type, aggregate_type, aggregate_id, payload, status, attempt_count)
    SELECT n.native_event_key, 'TEAM_RECRUITMENT_NOTIFICATION', 'TEAM_RECRUITMENT', n.recruitment_id,
      json_object('type', n.type, 'target_type', n.target_type, 'recipient_id', n.recipient_id,
        'recruitment_id', n.recruitment_id, 'application_id', n.application_id, 'chat_room_id', n.chat_room_id,
        'notification_id', n.id, 'message_preview', n.message_preview), 'PENDING', 0
    FROM ${notifications} n WHERE (${predicate}) AND n.native_event_key IS NOT NULL
    ON CONFLICT(event_key) DO NOTHING`;
}

export function closureStatements(
  db: Database,
  recruitmentId: number,
  reason: 'CLOSED' | 'DELETED' | 'CAPACITY' | 'ACCEPTANCE_CAPACITY' | 'DEADLINE',
  guard: SQL,
) {
  const deleted = reason === 'DELETED';
  const acceptedType = deleted ? 'RECRUITMENT_DELETED' : 'RECRUITMENT_CLOSED';
  const rejectedText =
    reason === 'ACCEPTANCE_CAPACITY'
      ? ' 지원이 거절되었어요.'
      : deleted
        ? ' 모집이 삭제되어 지원이 취소되었어요.'
        : ' 모집이 마감되어 지원이 거절되었어요.';
  const acceptedText = deleted ? ' 모집이 삭제되었어요.' : ' 모집이 마감되었어요.';
  const result = [];
  if (reason === 'DEADLINE') {
    result.push(sql`SELECT CASE WHEN NOT (${guard}) OR NOT EXISTS
      (SELECT 1 FROM ${applications} WHERE recruitment_id = ${recruitmentId} AND status = 'ACCEPTED')
      OR EXISTS (SELECT 1 FROM ${rooms} WHERE recruitment_id = ${recruitmentId} AND room_scope_key = 'TEAM' AND room_type = 'TEAM')
      THEN 1 ELSE json_extract('missing team recruitment room', '$') END`);
  }
  result.push(sql`INSERT INTO ${notifications}
    (native_event_key, recipient_id, type, target_type, message_preview, recruitment_id, application_id, chat_room_id)
    SELECT 'team-recruitment:application:' || a.id || ':' || CASE WHEN a.status = 'PENDING' THEN 'APPLICATION_REJECTED' ELSE ${acceptedType} END,
      a.applicant_id, CASE WHEN a.status = 'PENDING' THEN 'APPLICATION_REJECTED' ELSE ${acceptedType} END,
      CASE WHEN a.status = 'PENDING' OR room.id IS NULL THEN 'MY_APPLICATIONS' ELSE 'CHAT_ROOM' END,
      substr(CASE WHEN a.status = 'PENDING' THEN ${reason === 'ACCEPTANCE_CAPACITY' ? '' : '지원하신 '} || coalesce(r.title, '팀원 모집') || ${rejectedText}
        ELSE coalesce(r.title, '팀원 모집') || ${acceptedText} END, 1, 255), r.id, a.id,
      CASE WHEN a.status = 'PENDING' THEN NULL ELSE room.id END
    FROM ${applications} a JOIN ${recruitments} r ON r.id = a.recruitment_id
    LEFT JOIN ${rooms} room ON room.recruitment_id = r.id AND room.room_scope_key = 'TEAM'
    WHERE r.id = ${recruitmentId} AND a.status IN ('PENDING', 'ACCEPTED') AND a.applicant_id IS NOT NULL AND (${guard})
      AND NOT EXISTS (SELECT 1 FROM ${outbox} e WHERE e.event_key = 'team-recruitment:application:' || a.id || ':' ||
        CASE WHEN a.status = 'PENDING' THEN 'APPLICATION_REJECTED' ELSE ${acceptedType} END)
    ON CONFLICT(native_event_key) DO NOTHING`);
  result.push(
    outboxStatement(
      db,
      sql`n.recruitment_id = ${recruitmentId} AND n.type IN ('APPLICATION_REJECTED', ${acceptedType}) AND (${guard})`,
    ),
  );
  result.push(sql`UPDATE ${applications} SET status = 'REJECTED', decision_reason = ${deleted ? 'RECRUITMENT_DELETED' : 'RECRUITMENT_CLOSED'},
    updated_at = CURRENT_TIMESTAMP WHERE recruitment_id = ${recruitmentId} AND status = 'PENDING' AND (${guard})`);
  return result;
}

export function kstDate(now: number = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function kstTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const utc = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const fraction = value.match(/\.(\d+)/)?.[1];
  const local = new Date(new Date(utc).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return fraction ? `${local}.${fraction}` : local;
}

export function displayNickname(userId: number | null, nickname: string | null | undefined): string {
  return userId === null ? '탈퇴한 회원' : nickname?.trim() ? nickname : '익명 사용자';
}

export function messageWindow(after: string | undefined, before: string | undefined, limit: string | undefined) {
  const afterId = after === undefined ? null : integer(after);
  const beforeId = before === undefined ? null : integer(before);
  const count = limit === undefined ? 100 : integer(limit);
  if ((afterId !== null && beforeId !== null) || count < 1 || count > 200) illegal();
  return { afterId, beforeId, count };
}

function illegal(): never {
  throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
}
function integer(value: string): number {
  if (!/^\d+$/.test(value)) illegal();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647) illegal();
  return parsed;
}
function signedInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) illegal();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) illegal();
  return parsed;
}
function chatForbidden(): never {
  throw new ApiError(403, 'TEAM_RECRUITMENT_CHAT_FORBIDDEN', '채팅방에 대한 권한이 없습니다.');
}
function closed(): never {
  throw new ApiError(409, 'TEAM_RECRUITMENT_CLOSED', '마감된 팀원 모집글입니다.');
}
function requestIds(c: Context<ApiEnv>) {
  return {
    userId: requirePrincipal(c, ['STUDENT']).id,
    recruitmentId: integer(c.req.param('recruitmentId') ?? ''),
    roomId: integer(c.req.param('chatRoomId') ?? ''),
  };
}
type Room = {
  id: number;
  recruitment_id: number;
  room_type: string;
  application_id: number | null;
  title: string;
  max_participants: number;
  author_id: number | null;
  applicant_id: number | null;
};
async function authorizedRoom(db: Database, userId: number, recruitmentId: number, roomId: number): Promise<Room> {
  const room = await db.get<Room>(sql`SELECT room.*, r.title, r.max_participants, r.author_id, a.applicant_id
    FROM ${rooms} room JOIN ${recruitments} r ON r.id = room.recruitment_id
    LEFT JOIN ${applications} a ON a.id = room.application_id WHERE room.id = ${roomId} AND r.id = ${recruitmentId}`);
  if (!room) throw new ApiError(404, 'TEAM_RECRUITMENT_CHAT_NOT_FOUND', '채팅방이 존재하지 않습니다.');
  if (!(await db.get(sql`SELECT id FROM ${members} WHERE chat_room_id = ${roomId} AND user_id = ${userId}`)))
    chatForbidden();
  return room;
}
async function counterpart(db: Database, roomId: number, userId: number) {
  const other = await db.get<{
    id: number;
    nickname: string | null;
  }>(sql`SELECT m.user_id id, p.profile_nickname nickname
    FROM ${members} m LEFT JOIN ${profiles} p ON p.user_id = m.user_id
    WHERE m.chat_room_id = ${roomId} AND m.user_id <> ${userId} ORDER BY m.id LIMIT 1`);
  return { id: other?.id ?? null, nickname: displayNickname(other?.id ?? null, other?.nickname) };
}
type Message = {
  id: number;
  sender_id: number | null;
  content: string;
  created_at: string;
  is_image: number;
  nickname: string | null;
  unread_count: number;
};
function messageDto(message: Message) {
  return {
    message_id: message.id,
    user_id: message.sender_id,
    user_nickname: displayNickname(message.sender_id, message.nickname),
    content: message.content,
    timestamp: kstTimestamp(message.created_at),
    is_image: Boolean(message.is_image),
    unread_count: message.unread_count,
  };
}
function messageSelect(roomId: number) {
  return sql`SELECT msg.*, p.profile_nickname nickname,
    (SELECT count(*) FROM ${members} m WHERE m.chat_room_id = msg.chat_room_id
      AND (msg.sender_id IS NULL OR m.user_id <> msg.sender_id)
      AND (m.last_read_message_id IS NULL OR m.last_read_message_id < msg.id)) unread_count
    FROM ${messages} msg LEFT JOIN ${profiles} p ON p.user_id = msg.sender_id WHERE msg.chat_room_id = ${roomId}`;
}

export function registerTeamChat(app: Hono<ApiEnv>): void {
  const base = '/chatroom/team-recruitment';
  app.get(base, async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const list = await db.all<{
      recruitment_id: number;
      chat_room_id: number;
      title: string;
      room_type: string;
      counterpart_id: number | null;
      nickname: string | null;
      last_message_id: number | null;
      last_message_content: string | null;
      last_message_at: string | null;
      last_message_is_image: number | null;
      unread_message_count: number;
    }>(sql`SELECT room.recruitment_id, room.id chat_room_id, r.title, room.room_type,
        other.user_id counterpart_id, p.profile_nickname nickname, msg.id last_message_id, msg.content last_message_content,
        msg.created_at last_message_at, msg.is_image last_message_is_image,
        (SELECT count(*) FROM ${messages} unread WHERE unread.chat_room_id = room.id
          AND (unread.sender_id IS NULL OR unread.sender_id <> ${userId}) AND (mine.last_read_message_id IS NULL OR unread.id > mine.last_read_message_id)) unread_message_count
      FROM ${members} mine JOIN ${rooms} room ON room.id = mine.chat_room_id JOIN ${recruitments} r ON r.id = room.recruitment_id
      LEFT JOIN ${members} other ON other.id = (SELECT min(id) FROM ${members} WHERE chat_room_id = room.id AND user_id <> ${userId}) AND room.room_type = 'DIRECT'
      LEFT JOIN ${profiles} p ON p.user_id = other.user_id
      LEFT JOIN ${messages} msg ON msg.id = (SELECT max(id) FROM ${messages} WHERE chat_room_id = room.id)
      WHERE mine.user_id = ${userId} ORDER BY msg.created_at DESC, room.id DESC`);
    return c.json(
      list.map(({ title, nickname, last_message_is_image, last_message_at, ...item }) => {
        const name = item.room_type === 'DIRECT' ? displayNickname(item.counterpart_id, nickname) : null;
        return {
          ...item,
          room_name: name ?? title,
          counterpart_nickname: name,
          last_message_at: kstTimestamp(last_message_at),
          last_message_is_image: last_message_is_image === null ? null : Boolean(last_message_is_image),
        };
      }),
    );
  });
  app.get(`${base}/:recruitmentId/:chatRoomId`, async (c) => {
    const { userId, recruitmentId, roomId } = requestIds(c);
    const db = c.get('db');
    const room = await authorizedRoom(db, userId, recruitmentId, roomId);
    const other = room.room_type === 'DIRECT' ? await counterpart(db, roomId, userId) : null;
    const count = await db.get<{ count: number }>(
      sql`SELECT count(*) count FROM ${members} WHERE chat_room_id = ${roomId}`,
    );
    return c.json({
      chat_room_id: roomId,
      room_name: other?.nickname ?? room.title,
      room_type: room.room_type,
      member_count: count!.count,
      max_member_count: room.room_type === 'DIRECT' ? 2 : room.max_participants + 1,
      counterpart: other,
    });
  });
  app.post(`${base}/:recruitmentId/applications/:applicationId/direct`, async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const recruitmentId = integer(c.req.param('recruitmentId'));
    const applicationId = integer(c.req.param('applicationId'));
    const coordinated = await coordinateRequest(c, `team:${recruitmentId}`);
    if (coordinated) return coordinated;
    const db = c.get('db');
    const recruitment = await db.get<{ author_id: number | null }>(
      sql`SELECT author_id FROM ${recruitments} WHERE id = ${recruitmentId}`,
    );
    if (!recruitment) throw new ApiError(404, 'TEAM_RECRUITMENT_NOT_FOUND', '팀원 모집글이 존재하지 않습니다.');
    const application = await db.get<{ applicant_id: number | null; status: string }>(
      sql`SELECT applicant_id, status FROM ${applications} WHERE id = ${applicationId} AND recruitment_id = ${recruitmentId}`,
    );
    if (!application)
      throw new ApiError(404, 'TEAM_RECRUITMENT_APPLICATION_NOT_FOUND', '팀원 모집 지원서가 존재하지 않습니다.');
    if (userId !== recruitment.author_id && userId !== application.applicant_id)
      throw new ApiError(403, 'TEAM_RECRUITMENT_FORBIDDEN', '팀원 모집글에 대한 권한이 없습니다.');
    if (application.status !== 'ACCEPTED')
      throw new ApiError(409, 'TEAM_RECRUITMENT_APPLICATION_NOT_ACCEPTED', '승인된 지원서가 아닙니다.');
    let room = await db.get<{ id: number }>(
      sql`SELECT id FROM ${rooms} WHERE recruitment_id = ${recruitmentId} AND application_id = ${applicationId} AND room_type = 'DIRECT'`,
    );
    let created = false;
    if (!room) {
      if (recruitment.author_id === null || application.applicant_id === null)
        throw new ApiError(403, 'TEAM_RECRUITMENT_FORBIDDEN', '팀원 모집글에 대한 권한이 없습니다.');
      const today = kstDate();
      const result = await executeAtomic(db, [
        sql`INSERT INTO ${rooms} (recruitment_id, room_scope_key, room_type, application_id, status)
          SELECT r.id, ${`DIRECT-${applicationId}`}, 'DIRECT', a.id, 'ACTIVE' FROM ${recruitments} r
          JOIN ${applications} a ON a.recruitment_id = r.id WHERE r.id = ${recruitmentId} AND a.id = ${applicationId}
          AND a.status = 'ACCEPTED' AND r.author_id IS NOT NULL AND a.applicant_id IS NOT NULL AND (${userId} = r.author_id OR ${userId} = a.applicant_id)
          AND r.status <> 'DELETED' AND ((r.status = 'RECRUITING' AND (r.deadline_date IS NULL OR r.deadline_date >= ${today}))
            OR (r.status = 'CLOSED' AND EXISTS (SELECT 1 FROM ${rooms} WHERE recruitment_id = r.id AND room_scope_key = 'TEAM' AND room_type = 'TEAM')))
          ON CONFLICT DO NOTHING`,
        sql`INSERT INTO ${members} (chat_room_id, user_id) SELECT room.id, r.author_id FROM ${rooms} room
          JOIN ${recruitments} r ON r.id = room.recruitment_id WHERE room.recruitment_id = ${recruitmentId} AND room.application_id = ${applicationId}
          AND room.room_type = 'DIRECT' AND r.author_id IS NOT NULL ON CONFLICT DO NOTHING`,
        sql`INSERT INTO ${members} (chat_room_id, user_id) SELECT room.id, a.applicant_id FROM ${rooms} room
          JOIN ${applications} a ON a.id = room.application_id WHERE room.recruitment_id = ${recruitmentId} AND room.application_id = ${applicationId}
          AND room.room_type = 'DIRECT' AND a.applicant_id IS NOT NULL ON CONFLICT DO NOTHING`,
      ]);
      created = result[0].meta.changes > 0;
      room = await db.get<{ id: number }>(
        sql`SELECT id FROM ${rooms} WHERE recruitment_id = ${recruitmentId} AND application_id = ${applicationId} AND room_type = 'DIRECT'`,
      );
      if (!room) closed();
    }
    const otherId = userId === recruitment.author_id ? application.applicant_id : recruitment.author_id;
    const profile =
      otherId === null
        ? null
        : await db.get<{ profile_nickname: string | null }>(
            sql`SELECT profile_nickname FROM ${profiles} WHERE user_id = ${otherId}`,
          );
    const nickname = displayNickname(otherId, profile?.profile_nickname);
    return c.json(
      { chat_room_id: room.id, room_name: nickname, room_type: 'DIRECT', counterpart: { id: otherId, nickname } },
      created ? 201 : 200,
    );
  });
  app.get(`${base}/:recruitmentId/:chatRoomId/messages`, async (c) => {
    const { userId, recruitmentId, roomId } = requestIds(c);
    const { afterId, beforeId, count } = messageWindow(
      c.req.query('afterMessageId'),
      c.req.query('beforeMessageId'),
      c.req.query('limit'),
    );
    const db = c.get('db');
    await authorizedRoom(db, userId, recruitmentId, roomId);
    const condition =
      afterId !== null ? sql`AND msg.id > ${afterId}` : beforeId !== null ? sql`AND msg.id < ${beforeId}` : sql``;
    const order = afterId !== null ? sql`ASC` : sql`DESC`;
    const selected = await db.all<Message>(
      sql`${messageSelect(roomId)} ${condition} ORDER BY msg.id ${order} LIMIT ${count}`,
    );
    if (afterId === null) selected.reverse();
    if (selected.length) {
      const latest = selected[selected.length - 1]!.id;
      await db.run(sql`UPDATE ${members} SET last_read_message_id = max(coalesce(last_read_message_id, 0), ${latest}), updated_at = CURRENT_TIMESTAMP
        WHERE chat_room_id = ${roomId} AND user_id = ${userId}`);
      const refreshed = await db.all<Message>(
        sql`${messageSelect(roomId)} AND msg.id IN (${sql.join(
          selected.map((m) => sql`${m.id}`),
          sql`,`,
        )}) ORDER BY msg.id ASC`,
      );
      return c.json(refreshed.map(messageDto));
    }
    return c.json([]);
  });
  app.post(`${base}/:recruitmentId/:chatRoomId/messages`, async (c) => {
    const { userId, recruitmentId, roomId } = requestIds(c);
    const coordinated = await coordinateRequest(c, `team:${recruitmentId}`);
    if (coordinated) return coordinated;
    const body = await c.req.json<{ content?: unknown; is_image?: unknown }>();
    if (typeof body.content !== 'string' || !body.content.trim() || typeof body.is_image !== 'boolean') {
      throw new ApiError(400, 'INVALID_REQUEST_BODY', '잘못된 입력값이 포함되어 있습니다.');
    }
    const db = c.get('db');
    const room = await authorizedRoom(db, userId, recruitmentId, roomId);
    if (room.author_id === null || (room.room_type === 'DIRECT' && room.applicant_id === null)) chatForbidden();
    const profile = await db.get<{ profile_nickname: string | null }>(
      sql`SELECT profile_nickname FROM ${profiles} WHERE user_id = ${userId}`,
    );
    const nickname = displayNickname(userId, profile?.profile_nickname);
    const inserted = sql`(SELECT last_read_message_id FROM ${members} WHERE chat_room_id = ${roomId} AND user_id = ${userId})`;
    const result = await executeAtomic(db, [
      sql`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${members} m JOIN ${rooms} room ON room.id = m.chat_room_id
        JOIN ${recruitments} r ON r.id = room.recruitment_id LEFT JOIN ${applications} a ON a.id = room.application_id
        WHERE room.id = ${roomId} AND r.id = ${recruitmentId} AND m.user_id = ${userId} AND r.author_id IS NOT NULL
        AND (room.room_type <> 'DIRECT' OR a.applicant_id IS NOT NULL)) THEN 1 ELSE json_extract('chat forbidden', '$') END`,
      sql`INSERT INTO ${messages} (chat_room_id, sender_id, sender_nickname, content, is_image)
        VALUES (${roomId}, ${userId}, ${nickname}, ${body.content}, ${Number(body.is_image)})`,
      sql`UPDATE ${members} SET last_read_message_id = last_insert_rowid(), updated_at = CURRENT_TIMESTAMP
        WHERE chat_room_id = ${roomId} AND user_id = ${userId}`,
      sql`INSERT INTO ${notifications} (native_event_key, recipient_id, type, target_type, message_preview, sender_nickname, recruitment_id, application_id, chat_room_id)
        SELECT 'team-recruitment:chat-message:' || ${inserted} || ':' || user_id, user_id, 'NEW_CHAT_MESSAGE', 'CHAT_ROOM',
          ${body.content.slice(0, 255)}, ${nickname}, ${recruitmentId}, ${room.application_id}, ${roomId}
        FROM ${members} WHERE chat_room_id = ${roomId} AND user_id <> ${userId} ON CONFLICT(native_event_key) DO NOTHING`,
      outboxStatement(
        db,
        sql`n.chat_room_id = ${roomId} AND n.native_event_key LIKE 'team-recruitment:chat-message:' || ${inserted} || ':%'`,
      ),
      sql`${messageSelect(roomId)} AND msg.id = ${inserted}`,
    ]);
    c.executionCtx.waitUntil(signalTeamNotifications(c.env, recruitmentId));
    return c.json(messageDto(result[5]!.results[0] as Message));
  });
  registerNotifications(app);
}

function registerNotifications(app: Hono<ApiEnv>): void {
  const base = '/team-recruitments/notifications';
  app.get(base, async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const count = await db.get<{
      total: number;
      unread: number;
    }>(sql`SELECT count(*) total, coalesce(sum(read_at IS NULL), 0) unread
      FROM ${notifications} WHERE recipient_id = ${userId} AND is_deleted = 0`);
    const limit = Math.min(50, Math.max(1, signedInteger(c.req.query('limit'), 10)));
    const total = count!.total;
    const page = Math.min(Math.max(1, Math.ceil(total / limit)), Math.max(1, signedInteger(c.req.query('page'), 1)));
    const list = await db.all<{
      id: number;
      type: string;
      target_type: string;
      recruitment_id: number;
      application_id: number | null;
      chat_room_id: number | null;
      sender_nickname: string | null;
      message_preview: string;
      is_read: number;
      created_at: string;
    }>(sql`SELECT id, type, target_type, recruitment_id,
        application_id, chat_room_id, sender_nickname, message_preview, read_at IS NOT NULL is_read, created_at
      FROM ${notifications} WHERE recipient_id = ${userId} AND is_deleted = 0 ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
    return c.json({
      notifications: list.map((n) => ({ ...n, is_read: Boolean(n.is_read), created_at: kstTimestamp(n.created_at) })),
      unread_count: count!.unread,
      total_count: total,
      current_count: list.length,
      total_page: Math.ceil(total / limit),
      current_page: page,
    });
  });
  app.post(`${base}/mark-all-read`, async (c) => {
    const id = requirePrincipal(c, ['STUDENT']).id;
    await c
      .get('db')
      .run(
        sql`UPDATE ${notifications} SET read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE recipient_id = ${id} AND is_deleted = 0 AND read_at IS NULL`,
      );
    return c.body(null, 204);
  });
  app.post(`${base}/:notificationId/read`, async (c) => {
    const id = requirePrincipal(c, ['STUDENT']).id;
    await c.get('db').run(sql`UPDATE ${notifications} SET read_at = CURRENT_TIMESTAMP WHERE recipient_id = ${id}
      AND id = ${integer(c.req.param('notificationId'))} AND is_deleted = 0 AND read_at IS NULL`);
    return c.body(null, 204);
  });
  app.delete(base, async (c) => {
    const id = requirePrincipal(c, ['STUDENT']).id;
    await c
      .get('db')
      .run(
        sql`UPDATE ${notifications} SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE recipient_id = ${id} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });
  app.delete(`${base}/:notificationId`, async (c) => {
    const id = requirePrincipal(c, ['STUDENT']).id;
    await c
      .get('db')
      .run(
        sql`UPDATE ${notifications} SET is_deleted = 1 WHERE recipient_id = ${id} AND id = ${integer(c.req.param('notificationId'))} AND is_deleted = 0`,
      );
    return c.body(null, 204);
  });
}
