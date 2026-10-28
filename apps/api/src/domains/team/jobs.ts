import { sql, type SQL } from 'drizzle-orm';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { closureStatements, kstDate, signalTeamNotifications, type NotificationType } from '@api/domains/team/chat';
import { sendPush, FcmError } from '@api/integrations/push';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';

const outbox = schema.team_recruitment_outbox_event;
const notifications = schema.team_recruitment_notification;
const recruitments = schema.team_recruitment;
const users = schema.users;
const notificationTypes: Record<string, true> = {
  NEW_APPLICATION: true, APPLICATION_ACCEPTED: true, APPLICATION_REJECTED: true,
  RECRUITMENT_CLOSED: true, RECRUITMENT_DELETED: true, NEW_CHAT_MESSAGE: true,
};
const targets: Record<string, true> = { APPLICANT_MANAGEMENT: true, CHAT_ROOM: true, MY_APPLICATIONS: true, NONE: true };
const permanentCodes = ['INVALID_ARGUMENT', 'UNREGISTERED', 'SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR'];
export const TEAM_NOTIFICATION_JOB = 'team-recruitment.notification';
export const TEAM_DEADLINE_JOB = 'team-recruitment.deadline';

export function deadlineDelaySeconds(dueAt: string, now: number): number {
  const due = Date.parse(`${dueAt.replace(' ', 'T').replace(/Z$/, '')}Z`);
  if (!Number.isFinite(due)) throw new Error('Invalid durable team recruitment deadline');
  return Math.min(43200, Math.max(0, Math.ceil((due - now) / 1000)));
}

export interface OutboxConfiguration {
  enabled: boolean;
  batchSize: number;
  maxAttempts: number;
  leaseSeconds: number;
  retryBackoffSeconds: number;
  maxRetryBackoffSeconds: number;
}
type TeamSettings = {
  TEAM_RECRUITMENT_OUTBOX_ENABLED?: string;
  TEAM_RECRUITMENT_OUTBOX_BATCH_SIZE?: string;
  TEAM_RECRUITMENT_OUTBOX_MAX_ATTEMPTS?: string;
  TEAM_RECRUITMENT_OUTBOX_LEASE_SECONDS?: string;
  TEAM_RECRUITMENT_OUTBOX_RETRY_BACKOFF_SECONDS?: string;
  TEAM_RECRUITMENT_OUTBOX_MAX_RETRY_BACKOFF_SECONDS?: string;
};
export function outboxConfiguration(env: TeamSettings): OutboxConfiguration {
  const bounded = (raw: string | undefined, fallback: number, max: number) => {
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(parsed)) throw new Error('Invalid team recruitment outbox integer configuration');
    return Math.max(1, Math.min(max, parsed));
  };
  const retryBackoffSeconds = bounded(env.TEAM_RECRUITMENT_OUTBOX_RETRY_BACKOFF_SECONDS, 30, 86400);
  if (env.TEAM_RECRUITMENT_OUTBOX_ENABLED !== undefined && !['true', 'false'].includes(env.TEAM_RECRUITMENT_OUTBOX_ENABLED)) {
    throw new Error('TEAM_RECRUITMENT_OUTBOX_ENABLED must be true or false');
  }
  return {
    enabled: env.TEAM_RECRUITMENT_OUTBOX_ENABLED !== 'false',
    batchSize: bounded(env.TEAM_RECRUITMENT_OUTBOX_BATCH_SIZE, 20, 100),
    maxAttempts: bounded(env.TEAM_RECRUITMENT_OUTBOX_MAX_ATTEMPTS, 5, 100),
    leaseSeconds: bounded(env.TEAM_RECRUITMENT_OUTBOX_LEASE_SECONDS, 120, 86400),
    retryBackoffSeconds,
    maxRetryBackoffSeconds: Math.max(retryBackoffSeconds, bounded(env.TEAM_RECRUITMENT_OUTBOX_MAX_RETRY_BACKOFF_SECONDS, 3600, 86400)),
  };
}
export function backoffSeconds(attemptCount: number, config: OutboxConfiguration): number {
  return Math.min(config.maxRetryBackoffSeconds, config.retryBackoffSeconds * 2 ** Math.max(0, Math.min(attemptCount - 1, 30)));
}
function utcTimestamp(now: number): string { return new Date(now).toISOString().replace('T', ' ').replace('Z', ''); }

export interface OutboxPayload {
  type: NotificationType;
  target_type: string;
  recipient_id: number;
  recruitment_id: number;
  application_id: number | null;
  chat_room_id: number | null;
  notification_id: number | null;
  title?: string;
  content?: string;
  message_preview?: string;
}
class InvalidPayload extends Error {}
export function parseOutboxPayload(encoded: string): OutboxPayload {
  let input: unknown;
  try {
    input = JSON.parse(encoded);
  } catch {
    throw new InvalidPayload('INVALID_JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidPayload('INVALID_PAYLOAD');
  const value = input as Record<string, unknown>;
  if (typeof value.type !== 'string' || !value.type.trim()) throw new InvalidPayload('MISSING_TYPE');
  if (!Object.hasOwn(notificationTypes, value.type)) throw new InvalidPayload('INVALID_TYPE');
  if (typeof value.target_type !== 'string' || !value.target_type.trim()) throw new InvalidPayload('MISSING_TARGET_TYPE');
  if (!Object.hasOwn(targets, value.target_type)) throw new InvalidPayload('INVALID_TARGET_TYPE');
  const integer = (key: string): number | null => {
    const result = value[key];
    if (result === undefined || result === null) return null;
    if (typeof result !== 'number' || !Number.isInteger(result) || result < -2147483648 || result > 2147483647) {
      throw new InvalidPayload(`INVALID_${key.toUpperCase()}`);
    }
    return result;
  };
  const recipient = integer('recipient_id');
  const recruitment = integer('recruitment_id');
  if (recipient === null || recruitment === null) throw new InvalidPayload('MISSING_NOTIFICATION_TARGET');
  const text = (key: string) => typeof value[key] === 'string' && value[key].trim() ? value[key] : undefined;
  return { type: value.type as NotificationType, target_type: value.target_type, recipient_id: recipient, recruitment_id: recruitment,
    application_id: integer('application_id'), chat_room_id: integer('chat_room_id'), notification_id: integer('notification_id'),
    title: text('title'), content: text('content'), message_preview: text('message_preview') };
}

type Claim = { id: number; event_key: string; payload: string; attempt_count: number };
export function claimStatements(key: string, workerId: string, now: number, config: OutboxConfiguration): SQL[] {
  const timestamp = utcTimestamp(now);
  return [
    sql`UPDATE ${outbox} SET status = 'FAILED', last_error = 'MAX_ATTEMPTS_EXCEEDED',
      next_attempt_at = NULL, locked_until = NULL, worker_id = NULL, updated_at = ${timestamp}
      WHERE event_key = ${key} AND event_type = 'TEAM_RECRUITMENT_NOTIFICATION' AND status = 'PROCESSING'
        AND (locked_until IS NULL OR locked_until < ${timestamp}) AND attempt_count >= ${config.maxAttempts}`,
    sql`UPDATE ${outbox} SET status = 'PROCESSING', attempt_count = attempt_count + 1, worker_id = ${workerId},
      locked_until = ${utcTimestamp(now + config.leaseSeconds * 1000)}, updated_at = ${timestamp}
      WHERE event_key = ${key} AND event_type = 'TEAM_RECRUITMENT_NOTIFICATION' AND attempt_count < ${config.maxAttempts}
        AND ((status IN ('PENDING', 'FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= ${timestamp}))
          OR (status = 'PROCESSING' AND (locked_until IS NULL OR locked_until < ${timestamp})))
      RETURNING id, event_key, payload, attempt_count`,
  ];
}
export function completeStatement(id: number, workerId: string, now: number): SQL {
  return sql`UPDATE ${outbox} SET status = 'PUBLISHED', published_at = ${utcTimestamp(now)}, next_attempt_at = NULL,
    locked_until = NULL, worker_id = NULL, last_error = NULL, updated_at = ${utcTimestamp(now)}
    WHERE id = ${id} AND status = 'PROCESSING' AND worker_id = ${workerId}`;
}
export function renewLeaseStatement(id: number, workerId: string, now: number, leaseSeconds: number): SQL {
  return sql`UPDATE ${outbox} SET locked_until = ${utcTimestamp(now + leaseSeconds * 1000)}, updated_at = ${utcTimestamp(now)}
    WHERE id = ${id} AND status = 'PROCESSING' AND worker_id = ${workerId} AND locked_until >= ${utcTimestamp(now)}
    RETURNING id`;
}
export function failureStatement(id: number, workerId: string, attempt: number, reason: string, retryable: boolean, now: number, config: OutboxConfiguration): SQL {
  const terminal = !retryable || attempt >= config.maxAttempts;
  return sql`UPDATE ${outbox} SET status = 'FAILED', attempt_count = ${terminal ? Math.max(attempt, config.maxAttempts) : attempt},
    last_error = ${reason.trim() ? reason.slice(0, 500) : 'UNKNOWN_FAILURE'},
    next_attempt_at = ${terminal ? null : utcTimestamp(now + backoffSeconds(attempt, config) * 1000)}, locked_until = NULL,
    worker_id = NULL, updated_at = ${utcTimestamp(now)} WHERE id = ${id} AND status = 'PROCESSING' AND worker_id = ${workerId}`;
}
type Inbox = { id: number; recipient_id: number; type: string; target_type: string; recruitment_id: number;
  application_id: number | null; chat_room_id: number | null; is_deleted: number; message_preview: string };
export function inboxMatches(inbox: Inbox, payload: OutboxPayload): boolean {
  return inbox.recipient_id === payload.recipient_id && inbox.type === payload.type && inbox.target_type === payload.target_type
    && inbox.recruitment_id === payload.recruitment_id && inbox.application_id === payload.application_id && inbox.chat_room_id === payload.chat_room_id;
}
export function fallbackContent(type: NotificationType, title: string): string {
  const suffix: Record<NotificationType, string> = {
    NEW_APPLICATION: '에 새로운 지원자가 있어요.', APPLICATION_ACCEPTED: ' 지원이 승인되었어요.', APPLICATION_REJECTED: ' 지원이 거절되었어요.',
    RECRUITMENT_CLOSED: ' 모집이 마감되었어요.', RECRUITMENT_DELETED: ' 모집글이 삭제되었어요.', NEW_CHAT_MESSAGE: ' 새 메시지가 도착했어요.',
  };
  return title + suffix[type];
}
export function retryablePushError(error: unknown): boolean {
  if (!(error instanceof FcmError)) return true;
  const code = `${error.errorCode} ${error.messagingErrorCode}`.toUpperCase();
  return !permanentCodes.some((permanent) => code.includes(permanent));
}

async function publish(env: Bindings, db: Database, claim: Claim, workerId: string, config: OutboxConfiguration): Promise<void> {
  try {
    const payload = parseOutboxPayload(claim.payload);
    let inbox: Inbox | undefined;
    if (payload.notification_id !== null) {
      inbox = await db.get<Inbox>(sql`SELECT * FROM ${notifications} WHERE id = ${payload.notification_id}`);
      if (!inbox) throw new InvalidPayload('NOTIFICATION_NOT_FOUND');
      if (!inboxMatches(inbox, payload)) throw new InvalidPayload('NOTIFICATION_TARGET_MISMATCH');
    } else {
      const matching = await db.all<Inbox>(sql`SELECT * FROM ${notifications} WHERE recipient_id = ${payload.recipient_id}
        AND type = ${payload.type} AND target_type = ${payload.target_type} AND recruitment_id = ${payload.recruitment_id}
        AND application_id IS ${payload.application_id} AND chat_room_id IS ${payload.chat_room_id} ORDER BY id DESC LIMIT 2`);
      if (matching.length > 1) throw new InvalidPayload('AMBIGUOUS_NOTIFICATION_TARGET');
      inbox = matching[0];
    }
    if (inbox?.is_deleted) {
      await db.run(completeStatement(claim.id, workerId, Date.now()));
      return;
    }
    const recruitment = await db.get<{ title: string | null }>(sql`SELECT title FROM ${recruitments} WHERE id = ${payload.recruitment_id}`);
    if (!recruitment) throw new InvalidPayload('RECRUITMENT_NOT_FOUND');
    const recipient = await db.get<{ device_token: string | null }>(sql`SELECT device_token FROM ${users} WHERE id = ${payload.recipient_id}`);
    if (!recipient) throw new InvalidPayload('RECIPIENT_NOT_FOUND');
    if (!recipient.device_token?.trim()) throw new InvalidPayload('NO_DEVICE_TOKEN');
    const title = recruitment.title ?? '팀원 모집';
    const owner = await db.get(renewLeaseStatement(claim.id, workerId, Date.now(), config.leaseSeconds));
    if (!owner) return;
    await sendPush(env, { token: recipient.device_token, title: payload.title ?? title,
      body: payload.content ?? payload.message_preview ?? inbox?.message_preview ?? fallbackContent(payload.type, title),
      data: { type: payload.type.toLowerCase(), event_key: claim.event_key,
        ...(payload.notification_id === null ? {} : { notification_id: String(payload.notification_id) }) } });
    await db.run(completeStatement(claim.id, workerId, Date.now()));
  } catch (error) {
    const reason = error instanceof FcmError ? error.errorCode || error.messagingErrorCode || 'FCM_SEND_FAILED'
      : error instanceof Error ? error.message : String(error);
    await db.run(failureStatement(claim.id, workerId, claim.attempt_count, reason,
      !(error instanceof InvalidPayload) && retryablePushError(error), Date.now(), config));
    const retry = await db.get<{ event_key: string; next_attempt_at: string }>(sql`SELECT event_key, next_attempt_at FROM ${outbox}
      WHERE id = ${claim.id} AND status = 'FAILED' AND attempt_count < ${config.maxAttempts} AND next_attempt_at IS NOT NULL`);
    if (retry) {
      await env.JOBS.send({ kind: TEAM_NOTIFICATION_JOB, key: retry.event_key, payload: {} },
        { delaySeconds: deadlineDelaySeconds(retry.next_attempt_at, Date.now()) });
    }
  }
}

export async function handleTeamJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind === TEAM_DEADLINE_JOB) {
    await handleDeadlineJob(env, job);
    return true;
  }
  if (job.kind !== TEAM_NOTIFICATION_JOB) return false;
  const config = outboxConfiguration(env as Bindings & TeamSettings);
  if (!config.enabled) return true;
  const db = createDatabase(env.DB);
  const workerId = crypto.randomUUID();
  const result = await executeAtomic(db, claimStatements(job.key, workerId, Date.now(), config));
  const claim = result[1]?.results[0] as Claim | undefined;
  if (claim) {
    await publish(env, db, claim, workerId, config);
  } else {
    const deferred = await db.get<{ next_attempt_at: string }>(sql`SELECT next_attempt_at FROM ${outbox}
      WHERE event_key = ${job.key} AND event_type = 'TEAM_RECRUITMENT_NOTIFICATION' AND status IN ('PENDING', 'FAILED')
        AND attempt_count < ${config.maxAttempts} AND next_attempt_at > ${utcTimestamp(Date.now())}`);
    if (deferred) await env.JOBS.send(job, { delaySeconds: deadlineDelaySeconds(deferred.next_attempt_at, Date.now()) });
  }
  return true;
}

export function deadlineStatements(db: Database, recruitmentId: number, today: string, expectedDeadline?: string): SQL[] {
  const eligible = sql`EXISTS (SELECT 1 FROM ${recruitments} WHERE id = ${recruitmentId} AND status = 'RECRUITING'
    AND deadline_date IS NOT NULL AND deadline_date < ${today}
    AND (${expectedDeadline === undefined ? sql`1` : sql`deadline_date = ${expectedDeadline}`}))`;
  return [
    ...closureStatements(db, recruitmentId, 'DEADLINE', eligible),
    sql`UPDATE ${recruitments} SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE id = ${recruitmentId} AND (${eligible})`,
  ];
}

export async function runTeamCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60000) % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const today = kstDate(scheduledTime);
  const failures: unknown[] = [];
  const candidates = await db.all<{ id: number }>(sql`SELECT id FROM ${recruitments}
    WHERE status = 'RECRUITING' AND deadline_date < ${today} ORDER BY id ASC LIMIT 100`);
  for (const candidate of candidates) {
    try {
      await executeAtomic(db, deadlineStatements(db, candidate.id, today));
      await signalTeamNotifications(env, candidate.id);
    }
    catch (error) { failures.push(error); }
  }
  const config = outboxConfiguration(env as Bindings & TeamSettings);
  if (config.enabled && Math.floor(scheduledTime / 60000) % 5 === 0) {
    const now = utcTimestamp(Date.now());
    const ready = await db.all<{ event_key: string }>(sql`SELECT event_key FROM ${outbox}
      WHERE event_type = 'TEAM_RECRUITMENT_NOTIFICATION' AND (
        (status IN ('PENDING', 'FAILED') AND attempt_count < ${config.maxAttempts} AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
        OR (status = 'PROCESSING' AND (locked_until IS NULL OR locked_until < ${now}))) ORDER BY id ASC LIMIT ${config.batchSize}`);
    for (const event of ready) {
      try { await env.JOBS.send({ kind: TEAM_NOTIFICATION_JOB, key: event.event_key, payload: {} }); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Team recruitment scheduled work failed');
}

async function handleDeadlineJob(env: Bindings, job: Job): Promise<void> {
  const db = createDatabase(env.DB);
  const event = await db.get<{ id: number; aggregate_id: number; payload: string; next_attempt_at: string }>(sql`
    SELECT id, aggregate_id, payload, next_attempt_at FROM ${outbox}
    WHERE event_key = ${job.key} AND event_type = 'TEAM_RECRUITMENT_DEADLINE' AND status = 'PENDING'`);
  if (!event) return;
  const payload = JSON.parse(event.payload) as { deadline_date?: unknown; recruitment_id?: unknown };
  if (typeof payload.deadline_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.deadline_date)
    || payload.recruitment_id !== event.aggregate_id) throw new Error('Invalid durable team recruitment deadline payload');
  const current = await db.get(sql`SELECT id FROM ${recruitments} WHERE id = ${event.aggregate_id}
    AND status = 'RECRUITING' AND deadline_date = ${payload.deadline_date}`);
  if (current && deadlineDelaySeconds(event.next_attempt_at, Date.now()) > 0) {
    await env.JOBS.send(job, { delaySeconds: deadlineDelaySeconds(event.next_attempt_at, Date.now()) });
    return;
  }
  await executeAtomic(db, [
    ...deadlineStatements(db, event.aggregate_id, kstDate(), payload.deadline_date),
    sql`UPDATE ${outbox} SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${event.id} AND status = 'PENDING' AND (next_attempt_at <= ${utcTimestamp(Date.now())}
        OR NOT EXISTS (SELECT 1 FROM ${recruitments} WHERE id = ${event.aggregate_id}
          AND status = 'RECRUITING' AND deadline_date = ${payload.deadline_date}))`,
  ]);
  await signalTeamNotifications(env, event.aggregate_id);
}
