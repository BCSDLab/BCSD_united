import type { Context, Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { allocateBigintId, createDatabase } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { sendPush } from '@api/integrations';
import { FcmError } from '@api/integrations/push';
import { IntegrationError } from '@api/integrations/http';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { kstDate, parse, sqlNow } from '@api/domains/misc/helpers';

export const subscriptionTypes = [
  'SHOP_EVENT',
  'REVIEW_PROMPT',
  'DINING_SOLD_OUT',
  'DINING_IMAGE_UPLOAD',
  'ARTICLE_KEYWORD',
  'LOST_ITEM_CHAT',
  'CALLVAN',
  'MARKETING',
  'LOST_ITEM_KEYWORD',
] as const;
const details = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;
const mobilePaths = [
  'HOME',
  'LOGIN',
  'SHOP',
  'ORDER',
  'DINING',
  'KEYWORD',
  'LOST_ITEM',
  'CHAT',
  'CALLVAN',
  'CALLVAN_CHAT',
  'CLUB',
  'TIMETABLE',
] as const;
const users = ['GENERAL', 'STUDENT', 'OWNER', 'COOP', 'COUNCIL'] as const;
export interface NotificationDelivery {
  userId: number;
  title: string;
  message: string;
  imageUrl?: string | null;
  mobileAppPath?: string | null;
  schemeUri?: string | null;
  type?: string;
}
const deliveryPayload = z.object({
  userId: z.number().int().positive(),
  title: z.string(),
  message: z.string(),
  imageUrl: z.string().nullish(),
  mobileAppPath: z.string().nullish(),
  schemeUri: z.string().nullish(),
  type: z.string().optional(),
});
export function notificationStatus(
  deviceToken: string | null,
  subscriptions: { subscribe_type: string; detail_type: string | null }[],
) {
  return {
    is_permit: Boolean(deviceToken?.trim()),
    subscribes: subscriptionTypes.map((type) => ({
      type,
      is_permit: subscriptions.some((row) => row.subscribe_type === type && row.detail_type === null),
      detail_subscribes:
        type === 'DINING_SOLD_OUT'
          ? details.map((detail_type) => ({
              detail_type,
              is_permit: subscriptions.some((row) => row.detail_type === detail_type),
            }))
          : [],
    })),
  };
}
export async function deliverNotification(env: Bindings, input: NotificationDelivery): Promise<void> {
  const db = createDatabase(env.DB);
  const [user] = await db
    .select({ token: schema.users.device_token })
    .from(schema.users)
    .where(and(eq(schema.users.id, input.userId), eq(schema.users.is_deleted, false)));
  if (!user) throw new ApiError(404, 'NOT_FOUND', '사용자를 찾을 수 없습니다.');
  const id = await allocateBigintId(db, 'notification');
  const now = sqlNow();
  await db
    .insert(schema.notification)
    .values({
      id,
      users_id: input.userId,
      title: input.title,
      message: input.message,
      image_url: input.imageUrl ?? null,
      app_path: input.mobileAppPath ?? null,
      scheme_uri: input.schemeUri ?? null,
      type: (input.type ?? 'MESSAGE').toUpperCase(),
      is_read: false,
      created_at: now,
      updated_at: now,
    });
  try {
    if (!user.token?.trim()) throw new ApiError(422, 'NOTIFICATION_NOT_PERMITTED', '푸쉬알림을 동의하지 않았습니다.');
    const data: Record<string, string> = { type: (input.type ?? 'MESSAGE').toLowerCase() };
    if (input.mobileAppPath) data.path = input.mobileAppPath.toLowerCase().replaceAll('_', '-');
    if (input.imageUrl) data.imageUrl = input.imageUrl;
    if (input.schemeUri) data.schemeUri = input.schemeUri;
    await sendPush(env, { token: user.token, title: input.title, body: input.message, data });
    await db
      .update(schema.notification)
      .set({ is_push_success: true, updated_at: sqlNow() })
      .where(eq(schema.notification.id, id));
  } catch (error) {
    const errorCode = error instanceof FcmError ? error.errorCode : error instanceof ApiError ? error.code : 'UNKNOWN';
    await db
      .update(schema.notification)
      .set({
        is_push_success: false,
        fcm_error_code: errorCode,
        fcm_messaging_error_code: error instanceof FcmError ? error.messagingErrorCode : null,
        updated_at: sqlNow(),
      })
      .where(eq(schema.notification.id, id));
    throw error;
  }
}
async function permittedToken(c: Context<ApiEnv>) {
  const principal = requirePrincipal(c, [...users]);
  const [user] = await c
    .get('db')
    .select({ token: schema.users.device_token })
    .from(schema.users)
    .where(eq(schema.users.id, principal.id));
  if (!user?.token?.trim()) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '푸쉬알림을 동의하지 않았습니다.');
  return principal;
}
function subscribeType(value: string | undefined) {
  const type = value?.toUpperCase();
  if (!subscriptionTypes.some((candidate) => candidate === type))
    throw new ApiError(404, 'NOT_FOUND', '존재하지 않는 알림타입입니다.');
  return type!;
}
function detailType(value: string | undefined) {
  const type = value?.toUpperCase();
  if (!details.some((candidate) => candidate === type))
    throw new ApiError(404, 'NOT_FOUND', '존재하지 않는 알림타입입니다.');
  return type!;
}
export function registerNotifications(app: Hono<ApiEnv>) {
  app.get('/notification', async (c) => {
    const principal = requirePrincipal(c, [...users]);
    const [user] = await c
      .get('db')
      .select({ token: schema.users.device_token })
      .from(schema.users)
      .where(eq(schema.users.id, principal.id));
    const subscriptions = await c
      .get('db')
      .select()
      .from(schema.notification_subscribe)
      .where(eq(schema.notification_subscribe.user_id, principal.id));
    return c.json(notificationStatus(user?.token ?? null, subscriptions));
  });
  app.post('/notification', async (c) => {
    const principal = requirePrincipal(c, [...users]);
    const input = parse(
      z.object({
        device_token: z
          .string()
          .max(255)
          .refine((value) => value.trim().length > 0),
      }),
      await c.req.json(),
    );
    await c
      .get('db')
      .update(schema.users)
      .set({ device_token: input.device_token, updated_at: sqlNow() })
      .where(eq(schema.users.id, principal.id));
    return c.body(null, 201);
  });
  app.delete('/notification', async (c) => {
    const principal = requirePrincipal(c, [...users]);
    await c
      .get('db')
      .update(schema.users)
      .set({ device_token: null, updated_at: sqlNow() })
      .where(eq(schema.users.id, principal.id));
    return c.body(null, 204);
  });
  app.post('/notification/subscribe', async (c) => {
    const principal = await permittedToken(c);
    const type = subscribeType(c.req.query('type'));
    const db = c.get('db');
    const id = await allocateBigintId(db, 'notification_subscribe');
    const now = sqlNow();
    await db.run(
      sql`INSERT INTO ${schema.notification_subscribe} (id, user_id, subscribe_type, detail_type, created_at, updated_at) SELECT ${id}, ${principal.id}, ${type}, NULL, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM notification_subscribe WHERE user_id = ${principal.id} AND subscribe_type = ${type} AND detail_type IS NULL) AND EXISTS (SELECT 1 FROM users WHERE id = ${principal.id} AND length(trim(device_token)) > 0)`,
    );
    return c.body(null, 201);
  });
  app.post('/notification/subscribe/detail', async (c) => {
    const principal = await permittedToken(c);
    const detail = detailType(c.req.query('detail_type'));
    const db = c.get('db');
    const id = await allocateBigintId(db, 'notification_subscribe');
    const now = sqlNow();
    await db.run(
      sql`INSERT INTO ${schema.notification_subscribe} (id, user_id, subscribe_type, detail_type, created_at, updated_at) SELECT ${id}, ${principal.id}, 'DINING_SOLD_OUT', ${detail}, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM notification_subscribe WHERE user_id = ${principal.id} AND subscribe_type = 'DINING_SOLD_OUT' AND detail_type = ${detail}) AND EXISTS (SELECT 1 FROM users WHERE id = ${principal.id} AND length(trim(device_token)) > 0)`,
    );
    return c.body(null, 201);
  });
  app.delete('/notification/subscribe', async (c) => {
    const principal = await permittedToken(c);
    const type = subscribeType(c.req.query('type'));
    await c
      .get('db')
      .delete(schema.notification_subscribe)
      .where(
        and(
          eq(schema.notification_subscribe.user_id, principal.id),
          eq(schema.notification_subscribe.subscribe_type, type),
          isNull(schema.notification_subscribe.detail_type),
        ),
      );
    return c.body(null, 204);
  });
  app.delete('/notification/subscribe/detail', async (c) => {
    const principal = await permittedToken(c);
    const detail = detailType(c.req.query('detail_type'));
    await c
      .get('db')
      .delete(schema.notification_subscribe)
      .where(
        and(
          eq(schema.notification_subscribe.user_id, principal.id),
          eq(schema.notification_subscribe.detail_type, detail),
        ),
      );
    return c.body(null, 204);
  });
  app.post('/admin/notification/send', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const input = parse(
      z.object({
        subscribe_type: z.string(),
        detail_subscribe_type: z.string().nullish(),
        title: z.string().min(1).max(255),
        message: z.string().min(1).max(255),
        image_url: z.string().nullish(),
        schema_url: z.string().nullish(),
        mobile_app_path: z.enum(mobilePaths),
      }),
      await c.req.json(),
    );
    const type = subscribeType(input.subscribe_type);
    const detail = input.detail_subscribe_type ? detailType(input.detail_subscribe_type) : null;
    if (detail && type !== 'DINING_SOLD_OUT')
      throw new ApiError(400, 'INVALID_DETAIL_SUBSCRIBE_TYPE', '세부 구독 타입이 구독 타입에 속하지 않습니다.');
    const prefix = crypto.randomUUID();
    const now = new Date().toISOString();
    const queued = await c
      .get('db')
      .all<{ id: string }>(
        sql`INSERT INTO ${schema.native_notification_outbox} (id, payload, status, attempts, available_at, created_at) SELECT ${prefix} || ':' || ns.id, json_object('userId',ns.user_id,'title',${input.title},'message',${input.message},'imageUrl',${input.image_url ?? null},'schemeUri',${input.schema_url ?? null},'mobileAppPath',${input.mobile_app_path}), 'PENDING', 0, ${now}, ${now} FROM notification_subscribe ns JOIN users u ON u.id = ns.user_id WHERE ns.subscribe_type = ${type} AND ns.detail_type IS ${detail} AND u.device_token IS NOT NULL AND u.is_deleted = 0 RETURNING id`,
      );
    for (let offset = 0; offset < queued.length; offset += 100) {
      await c.env.JOBS.sendBatch(
        queued
          .slice(offset, offset + 100)
          .map(({ id }) => ({ body: { kind: 'misc.notification', key: id, payload: {} } })),
      );
    }
    return c.body(null, 200);
  });
}

async function deliverOutbox(env: Bindings, key: string) {
  const db = createDatabase(env.DB);
  const now = new Date().toISOString();
  const worker = crypto.randomUUID();
  const lease = new Date(Date.now() + 120_000).toISOString();
  const rows = await db.all<{ payload: string }>(
    sql`UPDATE ${schema.native_notification_outbox} SET status = 'PROCESSING', worker_id = ${worker}, locked_until = ${lease}, attempts = attempts + 1 WHERE id = ${key} AND available_at <= ${now} AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until <= ${now})) RETURNING payload`,
  );
  if (!rows.length) return;
  try {
    await deliverNotification(env, deliveryPayload.parse(JSON.parse(rows[0]!.payload)));
    await db
      .update(schema.native_notification_outbox)
      .set({ status: 'DONE', completed_at: new Date().toISOString(), locked_until: null, worker_id: null })
      .where(
        and(eq(schema.native_notification_outbox.id, key), eq(schema.native_notification_outbox.worker_id, worker)),
      );
  } catch (error) {
    const permanent =
      (error instanceof IntegrationError && !error.retryable) ||
      (error instanceof ApiError && (error.status === 404 || error.status === 422));
    await db
      .update(schema.native_notification_outbox)
      .set({
        status: permanent ? 'FAILED' : 'PENDING',
        available_at: new Date(Date.now() + 60_000).toISOString(),
        locked_until: null,
        worker_id: null,
      })
      .where(
        and(eq(schema.native_notification_outbox.id, key), eq(schema.native_notification_outbox.worker_id, worker)),
      );
    if (!permanent) {
      await env.JOBS.send({ kind: 'misc.notification', key, payload: {} }, { delaySeconds: 60 });
      throw error;
    }
  }
}
export async function handleMiscJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'misc.notification') return false;
  await deliverOutbox(env, job.key);
  return true;
}
export async function runMiscCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (new Date(scheduledTime).getUTCMinutes() % 5 !== 0) return;
  const db = createDatabase(env.DB);
  const now = new Date(scheduledTime).toISOString();
  const pending = await db.all<{ id: string }>(
    sql`SELECT id FROM ${schema.native_notification_outbox} WHERE available_at <= ${now} AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until <= ${now})) ORDER BY available_at`,
  );
  for (let offset = 0; offset < pending.length; offset += 100) {
    await env.JOBS.sendBatch(
      pending
        .slice(offset, offset + 100)
        .map(({ id }) => ({ body: { kind: 'misc.notification', key: id, payload: {} } })),
    );
  }
  const local = new Date(scheduledTime + 9 * 3_600_000).toISOString();
  if (local.slice(11, 16) === '00:00') {
    const end = new Date(`${kstDate(scheduledTime)}T00:00:00+09:00`).toISOString().slice(0, 19).replace('T', ' ');
    const start = new Date(Date.parse(end.replace(' ', 'T') + 'Z') - 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await db.run(
      sql`UPDATE ${schema.users} SET device_token = NULL, updated_at = ${sqlNow()} WHERE device_token IS NOT NULL AND EXISTS (SELECT 1 FROM notification n WHERE n.users_id = users.id AND n.is_push_success = 0 AND n.fcm_messaging_error_code = 'UNREGISTERED' AND n.created_at >= ${start} AND n.created_at < ${end} AND users.updated_at <= n.created_at)`,
    );
  }
}
