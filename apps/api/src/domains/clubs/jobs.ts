import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { sendSlack } from '@api/integrations';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import { deliverNotification, type NotificationDelivery } from '@api/domains/misc/notifications';
import { kstDate, lastWeek, localDateTime, sqlNow, utcMillis } from '@api/domains/clubs/behavior';
import { signalClubJobs } from '@api/domains/clubs/shared';
import { signalEventReminders } from '@api/domains/clubs/schedules';

interface ClubDelivery {
  userId: number;
  clubId: number;
  clubName: string;
  eventId?: number;
  eventName?: string;
  startDate?: string;
}

const deliverySchema = z.object({
  userId: z.number().int(), clubId: z.number().int(), clubName: z.string(),
  eventId: z.number().int().optional(), eventName: z.string().optional(), startDate: z.string().optional(),
});

async function signalInserted(env: Bindings, results: D1Result[]): Promise<void> {
  const ids: string[] = [];
  for (const result of results) for (const row of result.results ?? []) {
    if (typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string') ids.push(row.id);
  }
  await signalClubJobs(env, ids);
}

export function clubNotification(kind: string, payload: ClubDelivery): NotificationDelivery {
  if (kind === 'recruitment') return { userId: payload.userId, mobileAppPath: 'CLUB', schemeUri: `club-recruitment?id=${payload.clubId}`, type: 'MESSAGE',
    title: `[코인동아리] ${payload.clubName} 모집 공고가 갱신되었어요!`, message: `${payload.clubName}에 모집 정보가 새로 업데이트되었어요.\n행사 내용 둘러보기` };
  const base = { userId: payload.userId, mobileAppPath: 'CLUB', schemeUri: `club?clubId=${payload.clubId}&eventId=${payload.eventId}`, type: 'MESSAGE' };
  if (kind === 'day') {
    const local = localDateTime(payload.startDate!);
    const display = `${Number(local.slice(5, 7))}월 ${Number(local.slice(8, 10))}일 ${local.slice(11, 13)}시 ${local.slice(14, 16)}분`;
    return { ...base, title: `[코인 동아리] ${payload.clubName}에 내일 예정된 행사가 있어요!`,
      message: `${payload.eventName} - ${payload.clubName}의 행사가 ${display}에 진행 될 예정이에요.\n행사 내용 둘러보기` };
  }
  if (kind === 'hour') return { ...base, title: `[코인 동아리] 오늘 ${payload.clubName} 행사가 한 시간 남았어요!`,
    message: `${payload.eventName} - ${payload.clubName}의 행사가 1시간 뒤에 시작 할 예정이에요.\n행사 내용 둘러보기` };
  throw new ApiError(500, 'INVALID_CLUB_JOB', '지원하지 않는 동아리 알림 작업입니다.');
}

async function deliver(env: Bindings, id: string): Promise<void> {
  const db = createDatabase(env.DB);
  const now = sqlNow();
  const [scheduled] = await db.select().from(schema.native_club_outbox).where(and(eq(schema.native_club_outbox.id, id), isNull(schema.native_club_outbox.delivered_at)));
  if (!scheduled) return;
  if (scheduled.due_at > now) {
    await signalEventReminders(env, [{ id, dueAt: utcMillis(scheduled.due_at) }]);
    return;
  }
  const lease = new Date(Date.now() + 300_000).toISOString();
  const rows = await db.all<{ id: string; kind: string; payload: string }>(sql`UPDATE ${schema.native_club_outbox} SET lease_until=${lease} WHERE id=${id} AND delivered_at IS NULL AND due_at<=${now} AND (lease_until IS NULL OR lease_until<=${new Date().toISOString()}) RETURNING id,kind,payload`);
  const row = rows[0];
  if (!row) return;
  try {
    const payload = JSON.parse(row.payload);
    if (row.kind === 'event-hour' || row.kind === 'event-day') {
      const schedule = z.object({ eventId: z.number().int(), startDate: z.string() }).parse(payload);
      const kind = row.kind === 'event-hour' ? 'hour' : 'day';
      const condition = sql`e.id=${schedule.eventId} AND e.start_date=${schedule.startDate} AND ${kind === 'hour' ? sql`e.notified_before_one_hour=0 AND e.start_date>=${now}` : sql`1=1`}`;
      const results = await executeAtomic(db, [
        reminderSql(kind, condition, sql`1=1`, now),
        ...(kind === 'hour' ? [sql`UPDATE ${schema.club_event} SET notified_before_one_hour=1,updated_at=${now} WHERE id=${schedule.eventId} AND start_date=${schedule.startDate} AND start_date>=${now} AND notified_before_one_hour=0 AND EXISTS (SELECT 1 FROM ${schema.club_event_subscription} s WHERE s.event_id=club_event.id)`] : []),
        sql`UPDATE ${schema.native_club_outbox} SET delivered_at=${now},lease_until=NULL WHERE id=${id} AND lease_until=${lease}`,
      ]);
      await signalInserted(env, results);
      return;
    }
    if (row.kind === 'slack') {
      const slack = z.object({ clubName: z.string() }).parse(payload);
      if (!env.SLACK_KOIN_EVENT_NOTIFY_URL) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'SLACK_KOIN_EVENT_NOTIFY_URL 설정이 필요합니다.');
      await sendSlack(env, { webhook: env.SLACK_KOIN_EVENT_NOTIFY_URL, message: `\`${slack.clubName}\` 동아리 생성 요청이 들어왔습니다.\n` });
    } else {
      await deliverNotification(env, clubNotification(row.kind, deliverySchema.parse(payload)));
    }
    await db.update(schema.native_club_outbox).set({ delivered_at: sqlNow(), lease_until: null }).where(and(eq(schema.native_club_outbox.id, id), eq(schema.native_club_outbox.lease_until, lease)));
  } catch (error) {
    const permanent = (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false) || (error instanceof ApiError && [404, 422].includes(error.status));
    await db.update(schema.native_club_outbox).set({ lease_until: null, delivered_at: permanent ? sqlNow() : null, due_at: sqlNow(Date.now() + 60_000) }).where(and(eq(schema.native_club_outbox.id, id), eq(schema.native_club_outbox.lease_until, lease)));
    if (!permanent) throw error;
  }
}

export async function handleClubsJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'clubs.outbox') return false;
  await deliver(env, job.key);
  return true;
}

async function once(db: Database, key: string, build: (guard: SQL) => SQL[], now: string): Promise<D1Result[]> {
  const token = crypto.randomUUID();
  const guard = sql`EXISTS (SELECT 1 FROM ${schema.native_club_cron} WHERE key=${key} AND completed_at=${token})`;
  return executeAtomic(db, [
    sql`INSERT INTO ${schema.native_club_cron} (key,completed_at) VALUES (${key},${token}) ON CONFLICT(key) DO NOTHING`,
    ...build(guard),
    sql`UPDATE ${schema.native_club_cron} SET completed_at=${now} WHERE key=${key} AND completed_at=${token}`,
  ]);
}

function reminderSql(kind: 'day' | 'hour', condition: SQL, guard: SQL, now: string): SQL {
  return sql`INSERT INTO ${schema.native_club_outbox} (id,kind,payload,due_at)
    SELECT ${kind} || ':' || e.id || ':' || e.start_date || ':' || s.user_id, ${kind},
      json_object('userId',s.user_id,'clubId',c.id,'clubName',c.name,'eventId',e.id,'eventName',e.name,'startDate',e.start_date), ${now}
    FROM ${schema.club_event} e JOIN ${schema.club} c ON c.id=e.club_id JOIN ${schema.club_event_subscription} s ON s.event_id=e.id
    WHERE ${condition} AND ${guard} ON CONFLICT(id) DO NOTHING RETURNING id`;
}

export async function runClubsCron(env: Bindings, time: number): Promise<void> {
  if (new Date(time).getUTCMinutes() % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const now = sqlNow(time);
  const local = new Date(time + 9 * 3_600_000);
  const minute = local.getUTCMinutes();
  const hour = local.getUTCHours();
  if (minute % 10 === 0) await once(db, `hits:${Math.floor(time / 600000)}`, guard => [
    sql`UPDATE ${schema.club} SET hits=hits+COALESCE((SELECT h.hits FROM ${schema.native_club_hits} h WHERE h.club_id=club.id),0),updated_at=${now} WHERE id IN (SELECT club_id FROM ${schema.native_club_hits}) AND ${guard}`,
    sql`DELETE FROM ${schema.native_club_hits} WHERE club_id IN (SELECT id FROM ${schema.club}) AND ${guard}`,
  ], now);

  if (local.getUTCDay() === 1 && hour === 0 && minute === 0) {
    const period = lastWeek(time);
    await once(db, `hot:${period.start}`, guard => [
      sql`INSERT INTO ${schema.club_hot} (club_id,ranking,period_hits,start_date,end_date)
        SELECT id,1,hits-last_week_hits,${period.start},${period.end} FROM ${schema.club} WHERE ${guard} ORDER BY hits-last_week_hits DESC,id ASC LIMIT 1`,
      sql`INSERT INTO ${schema.native_club_hot} (key,payload) SELECT 'hot',json_object('club_id',c.id,'name',c.name,'image_url',c.image_url)
        FROM ${schema.club} c JOIN ${schema.club_hot} h ON h.club_id=c.id WHERE h.id=(SELECT MAX(id) FROM ${schema.club_hot}) AND ${guard}
        ON CONFLICT(key) DO UPDATE SET payload=excluded.payload`,
      sql`UPDATE ${schema.club} SET last_week_hits=hits,updated_at=${now} WHERE ${guard}`,
    ], now);
  }

  if (hour === 12 && minute === 30) {
    const tomorrow = new Date(`${kstDate(time)}T00:00:00+09:00`).getTime() + 86_400_000;
    const results = await once(db, `day:${kstDate(time)}`, guard => [reminderSql('day', sql`e.start_date>=${sqlNow(tomorrow)} AND e.start_date<${sqlNow(tomorrow + 86_400_000)}`, guard, now)], now);
    await signalInserted(env, results);
  }

  const results = await executeAtomic(db, [
    reminderSql('hour', sql`e.notified_before_one_hour=0 AND e.start_date>=${now} AND e.start_date<${sqlNow(time + 3_600_000)}`, sql`1=1`, now),
    sql`UPDATE ${schema.club_event} SET notified_before_one_hour=1,updated_at=${now}
      WHERE notified_before_one_hour=0 AND start_date>=${now} AND start_date<${sqlNow(time + 3_600_000)} AND EXISTS (SELECT 1 FROM ${schema.club_event_subscription} s WHERE s.event_id=club_event.id)`,
    sql`DELETE FROM ${schema.native_club_requests} WHERE expires_at<=${now}`,
  ]);
  await signalInserted(env, results);

  const pending = await db.select({ id: schema.native_club_outbox.id }).from(schema.native_club_outbox)
    .where(and(isNull(schema.native_club_outbox.delivered_at), lte(schema.native_club_outbox.due_at, sqlNow()),
      sql`(${schema.native_club_outbox.lease_until} IS NULL OR ${schema.native_club_outbox.lease_until}<=${new Date().toISOString()})`))
    .orderBy(schema.native_club_outbox.due_at).limit(100);
  await signalClubJobs(env, pending.map(row => row.id));
}
