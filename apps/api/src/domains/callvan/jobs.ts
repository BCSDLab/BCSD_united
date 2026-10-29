import { sql, type SQL } from 'drizzle-orm';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { IntegrationError, sendPush } from '@api/integrations';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import {
  activeParticipant,
  beginGuard,
  endGuard,
  enumeration,
  gate,
  locationName,
  object,
  queueDelaySeconds,
  signalEvents,
  utcText,
  type EventPayload,
  type EventType,
  type Notification,
} from '@api/domains/callvan/core';

type Event = typeof schema.native_callvan_event.$inferSelect;
type Delivery = typeof schema.native_callvan_delivery.$inferSelect;
const eventTypes: readonly EventType[] = [
  'PARTICIPANT_JOINED',
  'RECRUITMENT_COMPLETE',
  'NEW_MESSAGE',
  'DEPARTURE_UPCOMING',
  'REPORT_WARNING',
  'REPORT_RESTRICTION_14_DAYS',
  'REPORT_PERMANENT_RESTRICTION',
];

export function messagePreview(type: EventType, payload: EventPayload): string | null {
  switch (type) {
    case 'RECRUITMENT_COMPLETE':
      return '해당 콜벤팟 인원이 모두 모집되었습니다. 콜벤을 예약하세요';
    case 'REPORT_WARNING':
      return '콜벤팟 이용 과정에서 신고가 접수되어 운영 검토 후 주의 안내가 전달되었습니다. 이후 동일한 문제가 반복될 경우 콜벤 기능 이용이 제한될 수 있습니다.';
    case 'REPORT_RESTRICTION_14_DAYS':
      return '콜벤팟 이용 과정에서 신고가 접수되어 운영 검토 후 14일간 콜벤 기능 이용이 제한되었습니다.';
    case 'REPORT_PERMANENT_RESTRICTION':
      return '콜벤팟 이용 과정에서 신고가 접수되어 운영 검토 후 콜벤 기능 이용이 영구적으로 제한되었습니다.';
    case 'NEW_MESSAGE': {
      if (payload.is_image) return `${payload.sender_nickname}님이 사진을 보냈습니다.`;
      const content = payload.content ?? '';
      return content.length > 95 ? `${content.slice(0, 95)}...` : content;
    }
    case 'PARTICIPANT_JOINED':
    case 'DEPARTURE_UPCOMING':
      return null;
  }
}

export function pushMessage(notification: Notification) {
  const type = enumeration(notification.notification_type, eventTypes);
  let title: string;
  let body: string;
  switch (type) {
    case 'PARTICIPANT_JOINED':
      title = '콜벤팟 새 참여자';
      body = `${notification.joined_member_nickname}님이 콜벤팟에 참여했어요`;
      break;
    case 'DEPARTURE_UPCOMING':
      title = '콜벤팟 출발 30분 전';
      body = `${locationName(notification.departure_type, notification.departure_custom_name)} -> ${locationName(notification.arrival_type, notification.arrival_custom_name)} 콜벤팟이 30분 뒤 출발해요`;
      break;
    case 'NEW_MESSAGE':
      title = `콜벤팟 ${notification.sender_nickname}님의 메시지`;
      body = notification.message_preview ?? '';
      break;
    case 'RECRUITMENT_COMPLETE':
      title = '콜벤팟 인원 모집 완료';
      body = notification.message_preview ?? '';
      break;
    default:
      title = '콜벤팟 이용 안내';
      body = notification.message_preview ?? '';
  }
  return {
    title,
    body,
    data: {
      path: type === 'NEW_MESSAGE' ? 'callvan-chat' : 'callvan',
      schemeUri:
        type === 'NEW_MESSAGE'
          ? `callvan-chat?postId=${notification.callvan_post_id}&chatRoomId=${notification.callvan_chat_room_id}`
          : `callvan?id=${notification.callvan_post_id}`,
      type: type.toLowerCase(),
      notification_id: String(notification.id),
      imageUrl: '',
    },
  };
}

export function materializationStatements(event: Event, recipientIds: number[], key: string, now: string): SQL[] {
  const type = enumeration(event.type, eventTypes);
  const payload = object(JSON.parse(event.payload)) as EventPayload;
  const preview = messagePreview(type, payload);
  const sanction = type.startsWith('REPORT_');
  const statements: SQL[] = [
    beginGuard(
      key,
      sql`EXISTS (SELECT 1 FROM ${schema.native_callvan_event} WHERE id = ${event.id} AND completed_at IS NULL AND julianday(available_at) <= julianday(${now}))`,
    ),
  ];
  for (const recipientId of recipientIds) {
    const eligibility = sanction ? sql`1` : activeParticipant(event.post_id, recipientId);
    statements.push(
      sql`INSERT INTO ${schema.callvan_notification} (recipient_id, notification_type, callvan_post_id, departure_type, departure_custom_name, arrival_type, arrival_custom_name, departure_date, departure_time, current_participants, max_participants, sender_nickname, message_preview, callvan_chat_room_id, joined_member_nickname, is_read, is_deleted, created_at, updated_at) SELECT ${recipientId}, ${type}, p.id, p.departure_type, p.departure_custom_name, p.arrival_type, p.arrival_custom_name, p.departure_date, p.departure_time, p.current_participants, p.max_participants, ${type === 'NEW_MESSAGE' ? (payload.sender_nickname ?? null) : null}, ${preview}, ${type === 'DEPARTURE_UPCOMING' ? sql`NULL` : sql`p.chat_room_id`}, ${type === 'PARTICIPANT_JOINED' ? (payload.sender_nickname ?? null) : null}, 0, 0, ${now}, ${now} FROM ${schema.callvan_post} p WHERE p.id = ${event.post_id} AND p.is_deleted = 0 AND ${gate(key)} AND ${eligibility} AND EXISTS (SELECT 1 FROM ${schema.users} WHERE id = ${recipientId} AND is_deleted = 0)`,
      sql`INSERT INTO ${schema.native_callvan_delivery} (id, notification_id, created_at) SELECT ${`${event.id}:${recipientId}`}, last_insert_rowid(), ${now} WHERE changes() = 1 AND ${gate(key)}`,
    );
  }
  statements.push(
    sql`UPDATE ${schema.native_callvan_event} SET completed_at = ${now} WHERE id = ${event.id} AND ${gate(key)}`,
    endGuard(key),
  );
  return statements;
}

async function materialize(env: Bindings, db: Database, id: string): Promise<void> {
  const event = await db.get<Event>(sql`SELECT * FROM ${schema.native_callvan_event} WHERE id = ${id}`);
  if (!event) throw new ApiError(404, 'CALLVAN_EVENT_NOT_FOUND', '콜벤 알림 작업을 찾을 수 없습니다.');
  if (event.completed_at !== null) return;
  if (Date.parse(event.available_at.replace(' ', 'T') + 'Z') > Date.now()) {
    await signalEvents(env, [event.id], event.available_at);
    return;
  }
  const type = enumeration(event.type, eventTypes);
  const payload = object(JSON.parse(event.payload)) as EventPayload;
  let recipients: number[];
  if (type.startsWith('REPORT_')) {
    if (!Number.isSafeInteger(payload.recipient_id))
      throw new ApiError(500, 'CALLVAN_EVENT_INVALID', '콜벤 제재 알림 수신자가 올바르지 않습니다.');
    recipients = [payload.recipient_id!];
  } else {
    const excludeSender = type === 'PARTICIPANT_JOINED' || type === 'NEW_MESSAGE';
    if (excludeSender && !Number.isSafeInteger(payload.sender_id))
      throw new ApiError(500, 'CALLVAN_EVENT_INVALID', '콜벤 알림 발신자가 올바르지 않습니다.');
    recipients = (
      await db.all<{ member_id: number }>(
        sql`SELECT member_id FROM ${schema.callvan_participant} WHERE post_id = ${event.post_id} AND is_deleted = 0 AND ${excludeSender ? sql`member_id != ${payload.sender_id}` : sql`1`}`,
      )
    ).map((member) => member.member_id);
  }
  const results = await executeAtomic(db, materializationStatements(event, recipients, crypto.randomUUID(), utcText()));
  if (!results[0]?.meta.changes) return;
  const prefix = `${id}:`;
  const deliveries = await db.all<{ id: string }>(
    sql`SELECT id FROM ${schema.native_callvan_delivery} WHERE substr(id, 1, length(${prefix})) = ${prefix} AND delivered_at IS NULL`,
  );
  for (const delivery of deliveries) await env.JOBS.send({ kind: 'callvan.push', key: delivery.id, payload: {} });
}

export function claimDeliveryStatement(id: string, token: string, now: string, leaseUntil: string): SQL {
  return sql`UPDATE ${schema.native_callvan_delivery} SET lease_token = ${token}, lease_until = ${leaseUntil}, attempts = attempts + 1 WHERE id = ${id} AND delivered_at IS NULL AND (lease_until IS NULL OR julianday(lease_until) <= julianday(${now})) AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(${now}))`;
}

async function deliver(env: Bindings, db: Database, id: string): Promise<void> {
  const nowMs = Date.now();
  const now = utcText(nowMs);
  const token = crypto.randomUUID();
  const result = await executeAtomic(db, [claimDeliveryStatement(id, token, now, utcText(nowMs + 300_000))]);
  const delivery = await db.get<Delivery>(sql`SELECT * FROM ${schema.native_callvan_delivery} WHERE id = ${id}`);
  if (!result[0]?.meta.changes) {
    if (delivery?.delivered_at) return;
    if (!delivery) throw new ApiError(404, 'CALLVAN_DELIVERY_NOT_FOUND', '콜벤 푸시 작업을 찾을 수 없습니다.');
    const due = delivery.lease_until ?? delivery.next_attempt_at;
    if (due) {
      await env.JOBS.send({ kind: 'callvan.push', key: id, payload: {} }, { delaySeconds: queueDelaySeconds(due) });
      return;
    }
    throw new ApiError(503, 'CALLVAN_DELIVERY_LEASED', '콜벤 푸시 알림을 다른 작업에서 전송 중입니다.');
  }
  try {
    const notification = await db.get<Notification & { device_token: string | null; subscribed: number }>(
      sql`SELECT n.*, u.device_token, EXISTS (SELECT 1 FROM ${schema.notification_subscribe} s WHERE s.user_id = n.recipient_id AND s.subscribe_type = 'CALLVAN' AND s.detail_type IS NULL) AS subscribed FROM ${schema.native_callvan_delivery} d JOIN ${schema.callvan_notification} n ON n.id = d.notification_id JOIN ${schema.users} u ON u.id = n.recipient_id AND u.is_deleted = 0 WHERE d.id = ${id} AND d.lease_token = ${token} AND n.is_deleted = 0`,
    );
    if (notification?.device_token?.trim() && notification.subscribed)
      await sendPush(env, { token: notification.device_token, ...pushMessage(notification) });
    const ack = await executeAtomic(db, [
      sql`UPDATE ${schema.native_callvan_delivery} SET delivered_at = ${utcText()}, lease_token = NULL, lease_until = NULL, next_attempt_at = NULL, last_error = NULL WHERE id = ${id} AND lease_token = ${token} AND delivered_at IS NULL`,
    ]);
    if (!ack[0]?.meta.changes)
      throw new ApiError(503, 'CALLVAN_DELIVERY_LEASE_LOST', '콜벤 푸시 알림 전송 임대가 만료되었습니다.');
  } catch (error) {
    const retryable = error instanceof IntegrationError && error.retryable;
    const retryMs =
      error instanceof IntegrationError && error.retryAfterMs !== null
        ? error.retryAfterMs
        : Math.min(300_000, 5_000 * 2 ** Math.min(delivery?.attempts ?? 1, 6));
    const retryAt = retryable ? utcText(Date.now() + retryMs) : null;
    const released = await executeAtomic(db, [
      sql`UPDATE ${schema.native_callvan_delivery} SET lease_token = NULL, lease_until = NULL, next_attempt_at = ${retryAt}, last_error = ${error instanceof Error ? error.message : String(error)} WHERE id = ${id} AND lease_token = ${token} AND delivered_at IS NULL`,
    ]);
    if (released[0]?.meta.changes && retryAt)
      await env.JOBS.send({ kind: 'callvan.push', key: id, payload: {} }, { delaySeconds: queueDelaySeconds(retryAt) });
    throw error;
  }
}

export async function handleCallvanJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'callvan.event' && job.kind !== 'callvan.push') return false;
  const db = createDatabase(env.DB);
  if (job.kind === 'callvan.event') await materialize(env, db, job.key);
  else await deliver(env, db, job.key);
  return true;
}

export async function runCallvanCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60_000) % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const now = utcText(scheduledTime);
  let cursor = '';
  for (;;) {
    const events = await db.all<{ id: string }>(
      sql`SELECT id FROM ${schema.native_callvan_event} WHERE completed_at IS NULL AND julianday(available_at) <= julianday(${now}) AND id > ${cursor} ORDER BY id LIMIT 100`,
    );
    for (const event of events) await env.JOBS.send({ kind: 'callvan.event', key: event.id, payload: {} });
    if (events.length < 100) break;
    cursor = events[events.length - 1]!.id;
  }
  cursor = '';
  for (;;) {
    const deliveries = await db.all<{ id: string }>(
      sql`SELECT id FROM ${schema.native_callvan_delivery} WHERE delivered_at IS NULL AND (lease_until IS NULL OR julianday(lease_until) <= julianday(${now})) AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(${now})) AND id > ${cursor} ORDER BY id LIMIT 100`,
    );
    for (const delivery of deliveries) await env.JOBS.send({ kind: 'callvan.push', key: delivery.id, payload: {} });
    if (deliveries.length < 100) break;
    cursor = deliveries[deliveries.length - 1]!.id;
  }
}
