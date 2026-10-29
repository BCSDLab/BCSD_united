import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@api/db/schema';
import {
  activeParticipant,
  beginGuard,
  endGuard,
  eventStatement,
  gate,
  restrictionCondition,
} from '@api/domains/callvan/core';

export interface JoinMutation {
  key: string;
  postId: number;
  userId: number;
  nickname: string;
  now: string;
  joinedEventId: string;
  completeEventId: string;
}

export function joinStatements(input: JoinMutation): SQL[] {
  const { key, postId, userId, nickname, now, joinedEventId, completeEventId } = input;
  return [
    beginGuard(
      key,
      sql`EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND is_deleted = 0 AND status = 'RECRUITING' AND current_participants < max_participants AND julianday(departure_date || 'T' || departure_time || '+09:00') > julianday(${now})) AND NOT ${activeParticipant(postId, userId)} AND NOT ${restrictionCondition(userId, now)} AND EXISTS (SELECT 1 FROM ${schema.users} WHERE id = ${userId} AND is_deleted = 0)`,
    ),
    sql`UPDATE ${schema.callvan_post} SET current_participants = current_participants + 1, status = CASE WHEN current_participants + 1 >= max_participants THEN 'CLOSED' ELSE status END, updated_at = ${now} WHERE id = ${postId} AND ${gate(key)}`,
    sql`INSERT INTO ${schema.callvan_participant} (post_id, member_id, role, joined_at, is_deleted, created_at, updated_at) SELECT ${postId}, ${userId}, 'PARTICIPANT', ${now}, 0, ${now}, ${now} WHERE ${gate(key)} ON CONFLICT(post_id, member_id) DO UPDATE SET is_deleted = 0, updated_at = excluded.updated_at`,
    sql`UPDATE ${schema.callvan_chat_message} SET is_left_user = 0, updated_at = ${now} WHERE sender_id = ${userId} AND callvan_chat_room_id = (SELECT chat_room_id FROM ${schema.callvan_post} WHERE id = ${postId}) AND ${gate(key)}`,
    eventStatement(
      key,
      joinedEventId,
      postId,
      'PARTICIPANT_JOINED',
      { sender_id: userId, sender_nickname: nickname },
      now,
    ),
    eventStatement(
      key,
      completeEventId,
      postId,
      'RECRUITMENT_COMPLETE',
      {},
      now,
      now,
      sql`EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND current_participants >= max_participants)`,
    ),
    endGuard(key),
  ];
}

export function leaveStatements(key: string, postId: number, userId: number, now: string): SQL[] {
  return [
    beginGuard(
      key,
      sql`${activeParticipant(postId, userId)} AND EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND author_id != ${userId} AND is_deleted = 0)`,
    ),
    sql`UPDATE ${schema.callvan_participant} SET is_deleted = 1, updated_at = ${now} WHERE post_id = ${postId} AND member_id = ${userId} AND ${gate(key)}`,
    sql`UPDATE ${schema.callvan_post} SET current_participants = CASE WHEN current_participants > 1 THEN current_participants - 1 ELSE current_participants END, updated_at = ${now} WHERE id = ${postId} AND ${gate(key)}`,
    sql`UPDATE ${schema.callvan_chat_message} SET is_left_user = 1, updated_at = ${now} WHERE sender_id = ${userId} AND callvan_chat_room_id = (SELECT chat_room_id FROM ${schema.callvan_post} WHERE id = ${postId}) AND ${gate(key)}`,
    endGuard(key),
  ];
}

export function processStatements(
  key: string,
  reportId: number,
  adminId: number,
  type: string,
  now: string,
  until: string | null,
): SQL[] {
  return [
    beginGuard(
      key,
      sql`EXISTS (SELECT 1 FROM ${schema.callvan_report} WHERE id = ${reportId} AND is_deleted = 0 AND status = 'PENDING') AND NOT EXISTS (SELECT 1 FROM ${schema.callvan_report_process} WHERE report_id = ${reportId} AND is_deleted = 0)`,
    ),
    sql`INSERT INTO ${schema.callvan_report_process} (report_id, processor_id, process_type, restricted_until, is_deleted, created_at, updated_at) SELECT ${reportId}, ${adminId}, ${type}, ${until}, 0, ${now}, ${now} WHERE ${gate(key)}`,
    sql`UPDATE ${schema.callvan_report} SET status = ${type === 'REJECT' ? 'REJECTED' : 'CONFIRMED'}, reviewer_id = ${adminId}, reviewed_at = ${now}, confirmed_at = ${type === 'REJECT' ? null : now}, updated_at = ${now} WHERE id = ${reportId} AND ${gate(key)}`,
  ];
}
