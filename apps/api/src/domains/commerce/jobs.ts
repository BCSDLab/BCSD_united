import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDatabase } from '@api/db/client';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import { reconcilePayments } from '@api/domains/commerce/payments';
import { kstDate } from '@api/domains/commerce/rules';
import { first, guardedBatch } from '@api/domains/commerce/storage';

const orderEvent = z.object({
  orderId: z.number().int(),
  userId: z.number().int(),
  shopName: z.string(),
  status: z.enum(['COOKING', 'DELIVERING', 'PACKAGED', 'PICKED_UP', 'DELIVERED', 'CANCELED']),
  delivery: z.boolean(),
  estimatedAt: z.string().nullable(),
});
type OrderEvent = z.output<typeof orderEvent>;

const NOTIFICATION_TITLES: Record<OrderEvent['status'], string> = {
  COOKING: '주문이 접수되었어요',
  DELIVERING: '배달이 시작됐어요',
  PACKAGED: '포장이 완료됐어요',
  PICKED_UP: '주문 수령이 완료됐어요',
  DELIVERED: '배달이 완료됐어요',
  CANCELED: '주문이 취소됐어요',
};

function progressMessage(payload: OrderEvent): string {
  if (!payload.estimatedAt) throw new TypeError('조리 또는 배달 알림에는 예상 시각이 필요합니다.');
  const date = kstDate(payload.estimatedAt, 'iso');
  const estimated = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 ${date.slice(11, 16)}`;
  const label = payload.status === 'DELIVERING' || payload.delivery ? '예상 도착' : '포장 완료 예정';
  const prefix =
    payload.status === 'COOKING'
      ? `${payload.shopName}에서 조리를 시작했어요.`
      : `${payload.shopName}에서 주문하신 음식이 배달 중이에요.`;
  return `${prefix}\n${label}: ${estimated}`;
}

export function orderNotification(payload: OrderEvent) {
  let message: string;
  switch (payload.status) {
    case 'COOKING':
    case 'DELIVERING':
      message = progressMessage(payload);
      break;
    case 'PACKAGED':
      message = `${payload.shopName}에서 주문을 수령해 주세요.`;
      break;
    case 'CANCELED':
      message = `${payload.shopName} 주문의 자세한 내용은 주문 내역을 확인해 주세요.`;
      break;
    default:
      message = `${payload.shopName} 주문, 맛있게 드세요!`;
  }
  return {
    userId: payload.userId,
    title: NOTIFICATION_TITLES[payload.status],
    message,
    mobileAppPath: 'ORDER',
    schemeUri: `order?id=${payload.orderId}`,
    type: 'MESSAGE',
  };
}

/**
 * 주문 상태 아웃박스 행을 알림 아웃박스로 옮긴다. 기기 토큰이 없는 사용자는 알림 행을 만들지 않지만
 * 주문 아웃박스는 전달된 것으로 표시한다. 이미 전달된 행은 알림 작업만 다시 깨운다.
 */
export async function handleOrderJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'commerce.order-status') return false;
  const db = createDatabase(env.DB);
  const notificationKey = `commerce:${job.key}`;
  const row = await first<{ payload: string; delivered_at: string | null; available_at: number }>(
    db,
    sql`SELECT payload,delivered_at,available_at FROM native_commerce_outbox WHERE id=${job.key} AND kind='commerce.order-status'`,
  );
  if (!row || row.available_at > Date.now()) return true;
  if (row.delivered_at) {
    await env.JOBS.send({ kind: 'misc.notification', key: notificationKey, payload: {} });
    return true;
  }
  const payload = orderEvent.parse(JSON.parse(row.payload));
  const notification = orderNotification(payload);
  const now = new Date().toISOString();
  try {
    await guardedBatch(
      db,
      sql`EXISTS(SELECT 1 FROM native_commerce_outbox WHERE id=${job.key} AND delivered_at IS NULL)`,
      [
        sql`INSERT INTO native_notification_outbox(id,payload,status,attempts,available_at,created_at)
        SELECT ${notificationKey},${JSON.stringify(notification)},'PENDING',0,${now},${now}
        WHERE EXISTS(SELECT 1 FROM users WHERE id=${payload.userId} AND device_token IS NOT NULL AND length(trim(device_token))>0)
        ON CONFLICT(id) DO NOTHING`,
        sql`UPDATE native_commerce_outbox SET delivered_at=${now},attempts=attempts+1 WHERE id=${job.key}`,
      ],
    );
  } catch (error) {
    const delivered = await first<{ delivered_at: string | null }>(
      db,
      sql`SELECT delivered_at FROM native_commerce_outbox WHERE id=${job.key}`,
    );
    if (!delivered?.delivered_at) throw error;
  }
  await env.JOBS.send({ kind: 'misc.notification', key: notificationKey, payload: {} });
  return true;
}

export async function runOrderCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60_000) % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const rows = await db.all<{ id: string; kind: string }>(
    sql`SELECT id,kind FROM native_commerce_outbox WHERE delivered_at IS NULL AND available_at<=${scheduledTime} AND kind='commerce.order-status' ORDER BY available_at LIMIT 100`,
  );
  if (rows.length)
    await env.JOBS.sendBatch(rows.map((row) => ({ body: { kind: row.kind, key: row.id, payload: {} } })));
  await reconcilePayments(env, scheduledTime);
}
