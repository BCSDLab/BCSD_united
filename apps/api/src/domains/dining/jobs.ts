import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@api/db/client';
import type { Bindings } from '@api/runtime';
import type { Job } from '@api/jobs';
import { ApiError } from '@api/errors';
import { FcmError } from '@api/integrations/push';
import { deliverNotification, type NotificationDelivery } from '@api/domains/misc/notifications';
import { atomicDining, outboxStatement } from '@api/domains/dining/store';
import { cafeteriaOpened, rotateCoopSemester } from '@api/domains/dining/coopshop';
import { kstDate, type DiningRow, type DiningType } from '@api/domains/dining/protocol';

interface OutboxRow {
  id: string; kind: string; payload: string; due_at: string; lease_token: string | null;
  lease_expires_at: string | null; delivered_at: string | null;
}
function particle(place: string): string {
  const last = place.charCodeAt(place.length - 1);
  return place + (last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0 ? '이' : '가');
}
async function expandEvent(env: Bindings, db: Database, id: string): Promise<void> {
  await atomicDining(db, async () => {
    const event = await db.get<OutboxRow>(sql`SELECT * FROM native_dining_outbox WHERE id = ${id}`);
    const now = new Date();
    if (!event || event.delivered_at !== null || event.due_at > now.toISOString()) return { statements: [], value: undefined };
    const payload = JSON.parse(event.payload) as { dining_id: number; image_url?: string | null; place?: string; type?: DiningType };
    const statements = [];
    let subscribers: { user_id: number }[] = [];
    let notification: Omit<NotificationDelivery, 'userId'>;
    if (event.kind === 'dining.soldout') {
      const dining = await db.get<DiningRow>(sql`SELECT * FROM dining_menus WHERE id = ${payload.dining_id}`);
      const rateKey = `soldout:${payload.place}`;
      const throttled = await db.get(sql`SELECT 1 FROM native_dining_rate_limit WHERE key = ${rateKey} AND expires_at > ${now.toISOString()}`);
      const eligible = dining && dining.sold_out !== null && dining.date === kstDate(now) && !throttled && await cafeteriaOpened(db, now, dining.type, false);
      if (eligible) {
        subscribers = await db.all<{ user_id: number }>(sql`SELECT user_id FROM notification_subscribe WHERE subscribe_type = 'DINING_SOLD_OUT' AND detail_type = ${dining.type}`);
        statements.push(sql`INSERT INTO native_dining_rate_limit (key, expires_at) VALUES (${rateKey}, ${new Date(now.getTime() + 7_200_000).toISOString()}) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`);
      }
      notification = { title: `${particle(payload.place!)} 품절됐어요 \uD83D\uDE22`, message: '다른 코너 메뉴도 확인해보세요', mobileAppPath: 'DINING', schemeUri: `dining?id=${payload.dining_id}`, type: 'MESSAGE' };
    } else if (event.kind === 'dining.image') {
      subscribers = await db.all<{ user_id: number }>(sql`SELECT s.user_id FROM notification_subscribe s JOIN users u ON u.id = s.user_id WHERE s.subscribe_type = 'DINING_IMAGE_UPLOAD' AND s.detail_type IS NULL AND u.device_token IS NOT NULL`);
      notification = { title: '식단 사진이 업로드 됐어요!', message: '사진 보러 가기 \uD83D\uDE0B', imageUrl: payload.image_url, mobileAppPath: 'DINING', schemeUri: `dining?id=${payload.dining_id}`, type: 'MESSAGE' };
    } else throw new Error(`지원하지 않는 식단 이벤트: ${event.kind}`);
    const outboxIds = subscribers.map(() => crypto.randomUUID());
    subscribers.forEach((subscriber, index) => statements.push(outboxStatement('dining.push', { ...notification, userId: subscriber.user_id }, now.toISOString(), outboxIds[index]!)));
    statements.push(sql`UPDATE native_dining_outbox SET delivered_at = ${now.toISOString()} WHERE id = ${id} AND delivered_at IS NULL`);
    return { statements, outboxIds, value: undefined };
  }, env);
}
async function deliverPush(env: Bindings, db: Database, id: string): Promise<void> {
  const claimed = await atomicDining(db, async () => {
    const event = await db.get<OutboxRow>(sql`SELECT * FROM native_dining_outbox WHERE id = ${id}`);
    const now = new Date();
    if (!event || event.delivered_at || event.due_at > now.toISOString() || (event.lease_expires_at && event.lease_expires_at > now.toISOString())) return { statements: [], value: null };
    const token = crypto.randomUUID();
    return { statements: [sql`UPDATE native_dining_outbox SET lease_token = ${token}, lease_expires_at = ${new Date(now.getTime() + 300_000).toISOString()} WHERE id = ${id}`], value: { event, token } };
  });
  if (!claimed) return;
  try {
    await deliverNotification(env, JSON.parse(claimed.event.payload) as NotificationDelivery);
  } catch (error) {
    const terminal = error instanceof FcmError && !error.retryable || error instanceof ApiError && ['NOTIFICATION_NOT_PERMITTED', 'NOT_FOUND'].includes(error.code);
    if (!terminal) {
      await atomicDining(db, async () => ({ statements: [sql`UPDATE native_dining_outbox SET lease_token = NULL, lease_expires_at = NULL, due_at = ${new Date(Date.now() + 5_000).toISOString()} WHERE id = ${id} AND lease_token = ${claimed.token}`], value: undefined }));
      throw error;
    }
  }
  await atomicDining(db, async () => ({ statements: [sql`UPDATE native_dining_outbox SET delivered_at = ${new Date().toISOString()}, lease_token = NULL, lease_expires_at = NULL WHERE id = ${id} AND lease_token = ${claimed.token}`], value: undefined }));
}
export async function handleDiningJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'dining.outbox') return false;
  const db = createDatabase(env.DB);
  const event = await db.get<OutboxRow>(sql`SELECT * FROM native_dining_outbox WHERE id = ${job.key}`);
  if (!event || event.delivered_at) return true;
  if (event.due_at > new Date().toISOString()) throw new ApiError(503, 'DINING_JOB_NOT_DUE', '식단 알림 재시도 시각 전입니다.');
  if (event.kind === 'dining.push') await deliverPush(env, db, event.id);
  else await expandEvent(env, db, event.id);
  return true;
}
export async function runDiningCron(env: Bindings, scheduledTime: number): Promise<void> {
  const local = new Date(scheduledTime + 32_400_000);
  if (local.getUTCMinutes() % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const now = new Date(scheduledTime);
  if (local.getUTCHours() === 0 && local.getUTCMinutes() === 5) await rotateCoopSemester(db, now);
  const events = await db.all<{ id: string }>(sql`SELECT id FROM native_dining_outbox WHERE delivered_at IS NULL AND due_at <= ${now.toISOString()} AND (lease_expires_at IS NULL OR lease_expires_at <= ${now.toISOString()}) ORDER BY due_at, id LIMIT 100`);
  if (events.length) await env.JOBS.sendBatch(events.map((event) => ({ body: { kind: 'dining.outbox', key: event.id, payload: {} } })));
}
