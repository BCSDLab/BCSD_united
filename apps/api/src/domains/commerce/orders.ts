import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import type { ApiEnv, Bindings } from '@api/runtime';
import { cancelPayment, orderDetails, paymentOrder } from '@api/domains/commerce/payments';
import { commerceError, inProgressStatuses, kstDate, ownerStatusGroups, requireTransition, sqlNow, type OrderStatus } from '@api/domains/commerce/rules';
import { first, guardedBatch, outbox } from '@api/domains/commerce/storage';

interface OrderSummary extends Record<string, unknown> {
  id: number; user_id: number; orderable_shop_id: number; orderable_shop_name: string; order_number: string;
  status: string; order_type: string; created_at: string; total_price: number; payment_id: number;
  estimated_at: string | null; thumbnail: string | null; description: string; is_open: number;
}

const KST_OFFSET_MS = 9 * 3_600_000;
const PERIOD_MONTHS = { LAST_3_MONTHS: 3, LAST_6_MONTHS: 6, LAST_1_YEAR: 12 } as const;

const joinedOrder = sql`SELECT o.*,p.id AS payment_id,p.description,op.is_open,
  CASE WHEN o.order_type='DELIVERY' THEN d.estimated_arrival_at ELSE t.estimated_packaged_at END AS estimated_at,
  (SELECT image_url FROM orderable_shop_image WHERE orderable_shop_id=os.id AND is_thumbnail=1 AND is_deleted=0 LIMIT 1) AS thumbnail
  FROM order_v2 o JOIN payment_v2 p ON p.order_id=o.id JOIN orderable_shop os ON os.id=o.orderable_shop_id JOIN shops s ON s.id=os.shop_id
  LEFT JOIN shop_operation op ON op.shop_id=s.id AND op.is_deleted=0 LEFT JOIN order_delivery_v2 d ON d.order_id=o.id LEFT JOIN order_takeout_v2 t ON t.order_id=o.id`;
const listValues = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
const localSeconds = (value: string | null | undefined) => (value ? kstDate(value, 'iso').replace('T', ' ') : null);

/** KST 기준 `months`개월 전 같은 날짜(말일 보정)를 UTC `sqlNow` 형식으로 돌려준다. */
export function periodStart(now: Date, months: number): string {
  const result = new Date(now.getTime() + KST_OFFSET_MS);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return sqlNow(result.getTime() - KST_OFFSET_MS);
}

async function listOrders(db: Database, userId: number, query: Record<string, string | undefined>) {
  const page = z.coerce.number().int().min(1).parse(query.page ?? '1');
  const limit = z.coerce.number().int().min(1).parse(query.limit ?? '10');
  const status = z.enum(['NONE', 'COMPLETED', 'CANCELED']).parse(query.status ?? 'NONE');
  const type = z.enum(['NONE', 'DELIVERY', 'TAKE_OUT']).parse(query.type ?? 'NONE');
  const period = z.enum(['NONE', 'LAST_3_MONTHS', 'LAST_6_MONTHS', 'LAST_1_YEAR']).parse(query.period ?? 'NONE');
  const normalized = (query.query ?? '').replace(/\s+/g, '').toLowerCase();
  const statuses = status === 'COMPLETED' ? ['DELIVERED', 'PICKED_UP'] : status === 'CANCELED' ? ['CANCELED'] : ['DELIVERED', 'PICKED_UP', 'CANCELED'];
  const predicates = [
    sql`o.user_id=${userId}`,
    sql`o.is_deleted=0`,
    sql`p.is_deleted=0`,
    sql`o.status IN(${listValues(statuses)})`,
    sql`(instr(lower(s.internal_name),${normalized})>0 OR EXISTS(SELECT 1 FROM order_menu_v2 m WHERE m.order_id=o.id AND m.is_deleted=0 AND instr(lower(m.name),${normalized})>0))`,
  ];
  if (type !== 'NONE') predicates.push(sql`o.order_type=${type}`);
  if (period !== 'NONE') predicates.push(sql`o.created_at>=${periodStart(new Date(), PERIOD_MONTHS[period])}`);
  const where = sql.join(predicates, sql` AND `);
  const rows = await db.all<OrderSummary>(sql`${joinedOrder} WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
  const count = await first<{ count: number }>(db, sql`SELECT count(*) AS count FROM order_v2 o JOIN payment_v2 p ON p.order_id=o.id JOIN orderable_shop os ON os.id=o.orderable_shop_id JOIN shops s ON s.id=os.shop_id WHERE ${where}`);
  const total = count?.count ?? 0;
  return {
    total_count: total,
    current_count: rows.length,
    total_page: Math.ceil(total / limit),
    current_page: page,
    orders: rows.map((order) => ({
      id: order.id,
      payment_id: order.payment_id,
      orderable_shop_id: order.orderable_shop_id,
      orderable_shop_name: order.orderable_shop_name,
      open_status: Boolean(order.is_open),
      orderable_shop_thumbnail: order.thumbnail,
      order_date: kstDate(order.created_at, 'date').replaceAll('-', '.'),
      order_status: order.status,
      order_title: order.description,
      total_amount: order.total_price,
    })),
  };
}

async function requireOwner(db: Database, ownerId: number, orderableShopId: number) {
  const shop = await first<{ owner_id: number }>(db, sql`SELECT s.owner_id FROM orderable_shop os JOIN shops s ON s.id=os.shop_id WHERE os.id=${orderableShopId} AND os.is_deleted=0`);
  if (!shop) commerceError('NOT_FOUND_ORDERABLE_SHOP');
  if (shop.owner_id !== ownerId) commerceError('FORBIDDEN_SHOP_OWNER');
}

async function ownerOrder(db: Database, ownerId: number, shopId: number, orderId: number) {
  await requireOwner(db, ownerId, shopId);
  const order = await first<OrderSummary>(db, sql`${joinedOrder} WHERE o.id=${orderId} AND o.orderable_shop_id=${shopId} AND o.is_deleted=0 AND p.is_deleted=0`);
  if (!order) commerceError('NOT_FOUND_ORDER');
  return order;
}

async function ownerOrderResponse(db: Database, ownerId: number, shopId: number, orderId: number) {
  const order = await ownerOrder(db, ownerId, shopId, orderId);
  const payment = await paymentOrder(db, order.payment_id);
  const { fulfillment, menus, options } = await orderDetails(db, payment);
  return {
    id: order.id,
    order_number: order.order_number,
    order_type: order.order_type,
    order_status: order.status,
    ordered_at: localSeconds(order.created_at),
    order_menus: menus.map((menu) => ({
      id: menu.id,
      menu_name: menu.name,
      menu_price_name: menu.price_name,
      menu_price: menu.price,
      quantity: menu.quantity,
      options: options
        .filter((option) => option.order_menu_id === menu.id)
        .map((option) => ({ option_group_name: option.group_name, option_name: option.name, option_price: option.price, quantity: option.quantity })),
    })),
    receiver: {
      name: payment.receiver_name,
      phone_number: payment.phone_number,
      address: fulfillment.address ?? null,
      address_detail: fulfillment.address_detail ?? null,
      to_owner: fulfillment.to_owner,
      to_rider: fulfillment.to_rider ?? null,
      provide_cutlery: Boolean(fulfillment.provide_cutlery),
    },
    payment: {
      method: payment.method,
      approved_at: localSeconds(payment.approved_at),
      total_product_price: payment.total_product_price,
      delivery_tip: fulfillment.delivery_tip ?? 0,
      discount_amount: payment.discount_amount,
      total_price: payment.total_price,
    },
    completed_at: localSeconds(fulfillment.completed_at ?? fulfillment.packaged_at),
    canceled_at: localSeconds(payment.canceled_at),
    canceled_reason: payment.canceled_reason,
  };
}

const statusRequest = z.object({
  status: z.enum(['CONFIRMING', 'COOKING', 'PACKAGED', 'PICKED_UP', 'DELIVERING', 'DELIVERED', 'CANCELED']),
  estimated_minutes: z.number().int().positive().nullish(),
  canceled_reason: z.string().max(200).nullish(),
});

/** 상태별로 배달/포장 부속 테이블에 기록할 시각 갱신 문장. 해당 없는 상태는 빈 배열이다. */
function fulfillmentTimestamps(orderId: number, status: OrderStatus, delivery: boolean, estimated: string | null): SQL[] {
  switch (status) {
    case 'COOKING':
      return [delivery
        ? sql`UPDATE order_delivery_v2 SET estimated_arrival_at=${estimated},updated_at=CURRENT_TIMESTAMP WHERE order_id=${orderId}`
        : sql`UPDATE order_takeout_v2 SET estimated_packaged_at=${estimated},updated_at=CURRENT_TIMESTAMP WHERE order_id=${orderId}`];
    case 'DELIVERING':
      return [sql`UPDATE order_delivery_v2 SET dispatched_at=${sqlNow()},updated_at=CURRENT_TIMESTAMP WHERE order_id=${orderId}`];
    case 'DELIVERED':
      return [sql`UPDATE order_delivery_v2 SET completed_at=${sqlNow()},updated_at=CURRENT_TIMESTAMP WHERE order_id=${orderId}`];
    case 'PACKAGED':
      return [sql`UPDATE order_takeout_v2 SET packaged_at=${sqlNow()},updated_at=CURRENT_TIMESTAMP WHERE order_id=${orderId}`];
    default:
      return [];
  }
}

async function ownerChangeStatus(db: Database, env: Bindings, ownerId: number, shopId: number, orderId: number, body: z.output<typeof statusRequest>) {
  const order = await ownerOrder(db, ownerId, shopId, orderId);
  requireTransition(order.status, body.status, order.order_type);
  if (body.status === 'CANCELED') {
    if (!body.canceled_reason?.trim()) commerceError('REQUIRED_ORDER_CANCEL_REASON');
    await cancelPayment(db, env, order.payment_id, order.user_id, body.canceled_reason, true);
    return;
  }
  let estimated = order.estimated_at;
  if (body.status === 'COOKING') {
    if (body.estimated_minutes == null) commerceError('REQUIRED_ESTIMATED_MINUTES');
    estimated = sqlNow(Date.now() + body.estimated_minutes * 60_000);
  }
  const delivery = order.order_type === 'DELIVERY';
  const statements: SQL[] = [
    sql`UPDATE order_v2 SET status=${body.status},updated_at=CURRENT_TIMESTAMP WHERE id=${orderId}`,
    ...fulfillmentTimestamps(orderId, body.status, delivery, estimated),
    outbox('commerce.order-status', `${orderId}:${body.status}`, { orderId, userId: order.user_id, shopName: order.orderable_shop_name, status: body.status, delivery, estimatedAt: estimated }),
  ];
  // 취소 시도가 진행 중인 결제는 상태를 바꾸지 않는다.
  const unchanged = sql`EXISTS(SELECT 1 FROM order_v2 WHERE id=${orderId} AND status=${order.status}) AND NOT EXISTS(SELECT 1 FROM native_payment_cancel_attempt WHERE payment_id=${order.payment_id} AND status IN('PREPARED','CANCELING','RECONCILE'))`;
  await guardedBatch(db, unchanged, statements);
}

export function registerOrders(app: Hono<ApiEnv>): void {
  app.get('/order', async (c) => c.json(await listOrders(c.get('db'), requirePrincipal(c, ['STUDENT']).id, c.req.query())));
  app.get('/order/in-progress', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const rows = await c.get('db').all<OrderSummary>(sql`${joinedOrder} WHERE o.user_id=${userId} AND o.is_deleted=0 AND p.is_deleted=0 AND o.status IN(${listValues(inProgressStatuses)}) ORDER BY o.created_at DESC`);
    return c.json(rows.map((order) => ({
      id: order.id,
      orderable_shop_id: order.orderable_shop_id,
      payment_id: order.payment_id,
      order_type: order.order_type,
      orderable_shop_name: order.orderable_shop_name,
      orderable_shop_thumbnail: order.thumbnail,
      estimated_at: order.estimated_at ? kstDate(order.estimated_at, 'time') : null,
      order_status: order.status,
      order_title: order.description,
      total_amount: order.total_price,
    })));
  });
  app.get('/owner/order/shop/:orderableShopId/orders', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const shopId = Number(c.req.param('orderableShopId'));
    await requireOwner(c.get('db'), owner.id, shopId);
    const status = z.enum(['NEW', 'COOKING', 'DELIVERING', 'COMPLETED']).parse(c.req.query('status'));
    const orders = await c.get('db').all<OrderSummary>(sql`${joinedOrder} WHERE o.orderable_shop_id=${shopId} AND o.is_deleted=0 AND p.is_deleted=0 AND o.status IN(${listValues(ownerStatusGroups[status]!)}) ORDER BY o.created_at DESC`);
    return c.json({
      total_count: orders.length,
      orders: orders.map((order) => ({
        id: order.id,
        order_number: order.order_number,
        order_type: order.order_type,
        order_status: order.status,
        ordered_at: localSeconds(order.created_at),
        estimated_at: localSeconds(order.estimated_at),
        total_price: order.total_price,
      })),
    });
  });
  app.get('/owner/order/shop/:orderableShopId/orders/counts', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const shopId = Number(c.req.param('orderableShopId'));
    await requireOwner(c.get('db'), owner.id, shopId);
    const rows = await c.get('db').all<{ status: string; count: number }>(sql`SELECT status,count(*) AS count FROM order_v2 WHERE orderable_shop_id=${shopId} AND is_deleted=0 GROUP BY status`);
    const count = (group: string) => rows.reduce((sum, row) => sum + (ownerStatusGroups[group]!.includes(row.status as OrderStatus) ? row.count : 0), 0);
    return c.json({ new_count: count('NEW'), cooking_count: count('COOKING'), delivering_count: count('DELIVERING'), completed_count: count('COMPLETED') });
  });
  app.get('/owner/order/shop/:orderableShopId/orders/:orderId', async (c) => c.json(await ownerOrderResponse(c.get('db'), requirePrincipal(c, ['OWNER']).id, Number(c.req.param('orderableShopId')), Number(c.req.param('orderId')))));
  app.patch('/owner/order/shop/:orderableShopId/orders/:orderId/status', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const orderId = Number(c.req.param('orderId'));
    const request = statusRequest.parse(await c.req.json());
    await ownerChangeStatus(c.get('db'), c.env, owner.id, Number(c.req.param('orderableShopId')), orderId, request);
    c.executionCtx.waitUntil(c.env.JOBS.send({ kind: 'commerce.order-status', key: `commerce.order-status:${orderId}:${request.status}`, payload: {} }));
    return c.body(null, 200);
  });
  // 개발 환경에서만 열리는 경로. 주문자가 자기 주문의 상태를 전이 규칙 없이 직접 바꾼다.
  app.put('/order/:id/status', async (c) => {
    if (c.env.ENVIRONMENT !== 'development') return c.notFound();
    const user = requirePrincipal(c, ['STUDENT']);
    const id = Number(c.req.param('id'));
    const status = statusRequest.shape.status.parse(c.req.query('orderStatus'));
    const order = await first<OrderSummary>(c.get('db'), sql`${joinedOrder} WHERE o.id=${id} AND o.is_deleted=0`);
    if (!order) commerceError('NOT_FOUND_ORDER');
    if (order.user_id !== user.id) commerceError('FORBIDDEN_ORDER');
    const delivery = order.order_type === 'DELIVERY';
    const statements: SQL[] = [];
    if (status !== 'CONFIRMING') {
      statements.push(delivery
        ? sql`UPDATE order_delivery_v2 SET estimated_arrival_at=COALESCE(estimated_arrival_at,${sqlNow()}) WHERE order_id=${id}`
        : sql`UPDATE order_takeout_v2 SET estimated_packaged_at=COALESCE(estimated_packaged_at,${sqlNow()}) WHERE order_id=${id}`);
    }
    const supported = delivery ? ['COOKING', 'DELIVERING', 'DELIVERED'] : ['COOKING', 'PACKAGED', 'PICKED_UP'];
    if (supported.includes(status)) {
      statements.push(sql`UPDATE order_v2 SET status=${status},updated_at=CURRENT_TIMESTAMP WHERE id=${id}`);
      if (status === 'COOKING') {
        statements.push(delivery
          ? sql`UPDATE order_delivery_v2 SET estimated_arrival_at=${sqlNow()} WHERE order_id=${id}`
          : sql`UPDATE order_takeout_v2 SET estimated_packaged_at=${sqlNow()} WHERE order_id=${id}`);
      }
      if (status === 'DELIVERING') statements.push(sql`UPDATE order_delivery_v2 SET dispatched_at=${sqlNow()} WHERE order_id=${id}`);
      if (status === 'DELIVERED') statements.push(sql`UPDATE order_delivery_v2 SET completed_at=${sqlNow()} WHERE order_id=${id}`);
      if (status === 'PACKAGED') statements.push(sql`UPDATE order_takeout_v2 SET packaged_at=${sqlNow()} WHERE order_id=${id}`);
    }
    if (statements.length) await guardedBatch(c.get('db'), sql`EXISTS(SELECT 1 FROM order_v2 WHERE id=${id} AND user_id=${user.id} AND status=${order.status})`, statements);
    return c.body(null, 200);
  });
}
