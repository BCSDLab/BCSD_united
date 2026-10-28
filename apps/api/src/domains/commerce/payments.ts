import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import { tossCancel, tossConfirm, tossRetrieve, TossGatewayError, type TossPayment } from '@api/integrations/toss';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { validateDeliveryAddress } from '@api/domains/commerce/address-delivery';
import { cartAmounts, loadCart, type CartGraph } from '@api/domains/commerce/cart';
import { commerceError, kstDate, sqlNow, type OrderType } from '@api/domains/commerce/rules';
import { first, guardedBatch, outbox } from '@api/domains/commerce/storage';

interface CheckoutRequest {
  phone_number: string;
  address?: string;
  address_detail?: string | null;
  longitude?: number;
  latitude?: number;
  to_owner?: string | null;
  to_rider?: string | null;
  provide_cutlery: boolean;
}
interface CheckoutSnapshot {
  cart: CartGraph;
  request: CheckoutRequest;
  amounts: { itemsAmount: number; deliveryFee: number; totalAmount: number };
}
interface TemporaryPayment extends Record<string, unknown> {
  pg_order_id: string; user_id: number; orderable_shop_id: number; order_type: OrderType; snapshot_json: string;
  total_price: number; status: string; payment_key: string | null; idempotency_key: string; expires_at: number;
  claimed_until: number | null; attempts: number; gateway_json: string | null; completed_order_id: number | null;
}
export interface PaymentOrder extends Record<string, unknown> {
  id: number; order_id: number; payment_key: string; amount: number; status: string; method: string; description: string;
  easy_pay_company: string | null; requested_at: string; approved_at: string; receipt: string;
  user_id: number; order_type: OrderType; order_status: string; orderable_shop_id: number; orderable_shop_name: string;
  orderable_shop_address: string; orderable_shop_address_detail: string | null; total_product_price: number;
  total_price: number; discount_amount: number; order_number: string; phone_number: string; ordered_at: string;
  canceled_at: string | null; canceled_reason: string | null; receiver_name: string | null;
}
interface CancelAttempt extends Record<string, unknown> {
  payment_id: number; user_id: number; idempotency_key: string; cancel_reason: string; status: string;
  claimed_until: number | null; attempts: number; gateway_json: string | null;
}
interface Fulfillment extends Record<string, unknown> {
  address?: string; address_detail?: string | null; longitude?: string | null; latitude?: string | null;
  to_owner: string; to_rider?: string; provide_cutlery: number; delivery_tip?: number;
  estimated_arrival_at?: string | null; estimated_packaged_at?: string | null; completed_at?: string | null; packaged_at?: string | null;
}
interface OrderedMenu extends Record<string, unknown> { id: number; name: string; price_name: string | null; price: number; quantity: number }
interface OrderedOption extends Record<string, unknown> { order_menu_id: number; group_name: string; name: string; price: number; quantity: number }

const paymentMethods: Record<string, string> = {
  CARD: '카드',
  VIRTUAL_ACCOUNT: '가상계좌',
  EASY_PAY: '간편결제',
  MOBILE_PHONE: '휴대폰',
  ACCOUNT_TRANSFER: '계좌이체',
  CULTURE_GIFT_CERTIFICATE: '문화상품권',
  BOOK_CULTURE_GIFT_CERTIFICATE: '도서문화상품권',
  GAME_CULTURE_GIFT_CERTIFICATE: '게임문화상품권',
};
const baseTemporaryBody = z.object({
  phone_number: z.string().regex(/^\d{11}$/),
  to_owner: z.string().max(50).nullish(),
  provide_cutlery: z.boolean(),
  total_menu_price: z.number().int(),
  total_amount: z.number().int(),
});
const deliveryTemporaryBody = baseTemporaryBody.extend({
  address: z.string().trim().min(1),
  address_detail: z.string().nullish(),
  longitude: z.number(),
  latitude: z.number(),
  to_rider: z.string().max(50).nullish(),
  delivery_type: z.enum(['CAMPUS', 'OFF_CAMPUS']),
  delivery_tip: z.number().int(),
});
const confirmBody = z.object({ payment_key: z.string().trim().min(1), order_id: z.string().trim().min(1), amount: z.number().int() });

const TEMPORARY_PAYMENT_TTL_MS = 600_000;
const RECONCILE_BATCH = 30;
const FAILED_GATEWAY_STATUSES = ['ABORTED', 'EXPIRED', 'CANCELED'];

/** 임대 시간은 Toss 타임아웃보다 넉넉해야 같은 결제를 두 워커가 동시에 승인·취소하지 않는다. */
function leaseDeadline(env: Bindings): number {
  const timeout = Number(env.TOSS_API_TIMEOUT_MS ?? 15_000);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 120_000) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'TOSS_API_TIMEOUT_MS 설정이 올바르지 않습니다.');
  return Date.now() + Math.max(60_000, timeout + 30_000);
}

/** 재시도 간격: 5초부터 두 배씩, 최대 5분. */
function nextAttemptAt(attempts: number): number {
  return Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6));
}

/**
 * 게이트웨이 호출 결과를 알 수 없는 실패인지 판단한다. 불확실하면 RECONCILE로 남겨 조회 후 재시도하고,
 * 확실한 실패(설정 누락, 4xx 거절)만 PREPARED/FAILED로 되돌린다. 이미 처리됐다는 응답도 조회가 필요하므로 불확실로 본다.
 */
function uncertainGatewayFailure(error: unknown, alreadyProcessedCode: string): boolean {
  if (error instanceof TossGatewayError) return error.uncertain || error.code === alreadyProcessedCode;
  return !(error instanceof ApiError && error.code === 'INTEGRATION_NOT_CONFIGURED');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delaySecondsUntil(time: number): number {
  return Math.ceil((time - Date.now()) / 1_000);
}

export async function paymentOrder(db: Database, paymentId: number): Promise<PaymentOrder> {
  const row = await first<PaymentOrder>(db, sql`SELECT p.*,o.user_id,o.order_type,o.status AS order_status,o.orderable_shop_id,o.orderable_shop_name,
    o.orderable_shop_address,o.orderable_shop_address_detail,o.total_product_price,o.total_price,o.discount_amount,o.order_number,
    o.phone_number,o.created_at AS ordered_at,o.canceled_at,o.canceled_reason,u.name AS receiver_name
    FROM payment_v2 p JOIN order_v2 o ON o.id=p.order_id LEFT JOIN users u ON u.id=o.user_id WHERE p.id=${paymentId} AND p.is_deleted=0 AND o.is_deleted=0`);
  if (!row) commerceError('NOT_FOUND_PAYMENT');
  return row;
}

export async function orderDetails(db: Database, payment: PaymentOrder) {
  const fulfillmentQuery = payment.order_type === 'DELIVERY'
    ? sql`SELECT * FROM order_delivery_v2 WHERE order_id=${payment.order_id}`
    : sql`SELECT * FROM order_takeout_v2 WHERE order_id=${payment.order_id}`;
  const fulfillment = await first<Fulfillment>(db, fulfillmentQuery);
  if (!fulfillment) commerceError('NOT_FOUND_ORDER');
  const menus = await db.all<OrderedMenu>(sql`SELECT * FROM order_menu_v2 WHERE order_id=${payment.order_id} AND is_deleted=0 ORDER BY id`);
  const options = await db.all<OrderedOption>(sql`SELECT mo.* FROM order_menu_option_v2 mo JOIN order_menu_v2 m ON m.id=mo.order_menu_id WHERE m.order_id=${payment.order_id} AND mo.is_deleted=0 AND m.is_deleted=0 ORDER BY mo.id`);
  return { fulfillment, menus, options };
}

export async function paymentResponse(db: Database, paymentId: number, userId: number, confirmation = false) {
  const payment = await paymentOrder(db, paymentId);
  if (payment.user_id !== userId) commerceError('PAYMENT_ACCESS_DENIED');
  const { fulfillment, menus, options } = await orderDetails(db, payment);
  const shop = await first<{ name: string; address: string }>(db, sql`SELECT s.name,s.address FROM shops s JOIN orderable_shop os ON os.shop_id=s.id WHERE os.id=${payment.orderable_shop_id}`);
  const estimated = fulfillment.estimated_arrival_at ?? fulfillment.estimated_packaged_at;
  const response = {
    id: payment.id,
    orderable_shop_id: payment.orderable_shop_id,
    delivery_address: fulfillment.address ?? null,
    delivery_address_details: fulfillment.address_detail ?? null,
    shop_address: shop?.address ?? payment.orderable_shop_address,
    longitude: fulfillment.longitude == null ? null : Number(fulfillment.longitude),
    latitude: fulfillment.latitude == null ? null : Number(fulfillment.latitude),
    to_owner: fulfillment.to_owner,
    to_rider: fulfillment.to_rider ?? null,
    provide_cutlery: Boolean(fulfillment.provide_cutlery),
    total_menu_price: payment.total_product_price,
    delivery_tip: fulfillment.delivery_tip ?? null,
    amount: payment.total_price,
    shop_name: shop?.name ?? payment.orderable_shop_name,
    menus: menus.map((menu) => ({
      name: menu.name,
      quantity: menu.quantity,
      price: menu.price,
      options: options
        .filter((option) => option.order_menu_id === menu.id)
        .map((option) => ({ option_group_name: option.group_name, option_name: option.name, option_price: option.price })),
    })),
    order_type: payment.order_type,
    easy_pay_company: payment.easy_pay_company,
    requested_at: kstDate(payment.requested_at),
    approved_at: kstDate(payment.approved_at),
    payment_method: paymentMethods[payment.method] ?? payment.method,
  };
  if (confirmation) return response;
  return {
    ...response,
    estimated_at: payment.order_status === 'CONFIRMING' || !estimated ? null : kstDate(estimated, 'time'),
    order_status: payment.order_status,
  };
}

export async function createTemporaryPayment(db: Database, env: Bindings, userId: number, type: OrderType, raw: unknown) {
  const request = type === 'DELIVERY' ? deliveryTemporaryBody.parse(raw) : baseTemporaryBody.parse(raw);
  if ('delivery_type' in request && request.delivery_type === 'OFF_CAMPUS') await validateDeliveryAddress(env, request.address);
  const cart = (await loadCart(db, userId))!;
  const amounts = await cartAmounts(db, cart, type);
  const priceMismatch = request.total_menu_price !== amounts.itemsAmount
    || request.total_amount !== amounts.totalAmount
    || ('delivery_tip' in request && request.delivery_tip !== amounts.deliveryFee);
  if (priceMismatch) commerceError('ORDER_PRICE_MISMATCH');
  const orderId = crypto.randomUUID().replaceAll('-', '');
  const snapshot: CheckoutSnapshot = { cart, request, amounts };
  await guardedBatch(db, sql`EXISTS(SELECT 1 FROM native_commerce_revision WHERE user_id=${userId} AND revision=${cart.revision})`, [
    sql`INSERT INTO temporary_payment(pg_order_id,user_id,orderable_shop_id,order_type,snapshot_json,total_price,status,idempotency_key,created_at,expires_at,attempts)
      VALUES(${orderId},${userId},${cart.orderable_shop_id},${type},${JSON.stringify(snapshot)},${amounts.totalAmount},'PREPARED',${crypto.randomUUID()},${new Date().toISOString()},${Date.now() + TEMPORARY_PAYMENT_TTL_MS},0)`,
  ]);
  return { order_id: orderId };
}

export function assertGatewayMatches(gateway: Pick<TossPayment, 'orderId' | 'paymentKey' | 'totalAmount' | 'status'>, payment: { pg_order_id: string; payment_key: string | null; total_price: number }): void {
  if (gateway.orderId !== payment.pg_order_id || gateway.paymentKey !== payment.payment_key || gateway.totalAmount !== payment.total_price) commerceError('MISMATCH_TEMPORARY_PAYMENT');
  if (gateway.status !== 'DONE') commerceError('PAYMENT_CONFIRM_ERROR');
}

/** 영문 대문자·숫자 10자리. 36으로 나눈 나머지가 편향되지 않도록 252 이상의 바이트는 버린다. */
function randomOrderNumber(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  while (result.length < 10) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252) result += alphabet[byte % 36];
      if (result.length === 10) break;
    }
  }
  return result;
}

function orderInsertStatements(temporary: TemporaryPayment, snapshot: CheckoutSnapshot, orderId: SQL): SQL[] {
  const { cart, request, amounts } = snapshot;
  const statements: SQL[] = [
    sql`INSERT INTO order_v2(pg_order_id,order_number,user_id,phone_number,orderable_shop_id,orderable_shop_name,orderable_shop_address,orderable_shop_address_detail,total_product_price,discount_amount,total_price,order_type,status,is_deleted)
    VALUES(${temporary.pg_order_id},${randomOrderNumber()},${temporary.user_id},${request.phone_number},${temporary.orderable_shop_id},${cart.shop_name},${cart.shop_address},${cart.shop_address_detail},${amounts.itemsAmount},0,${temporary.total_price},${temporary.order_type},'CONFIRMING',0)`,
  ];
  if (temporary.order_type === 'DELIVERY') {
    statements.push(sql`INSERT INTO order_delivery_v2(order_id,address,address_detail,latitude,longitude,to_owner,to_rider,delivery_tip,provide_cutlery)
      VALUES(${orderId},${request.address!},${request.address_detail ?? null},${String(request.latitude)},${String(request.longitude)},${request.to_owner ?? ''},${request.to_rider ?? ''},${amounts.deliveryFee},${Number(request.provide_cutlery)})`);
  } else {
    statements.push(sql`INSERT INTO order_takeout_v2(order_id,to_owner,provide_cutlery) VALUES(${orderId},${request.to_owner ?? ''},${Number(request.provide_cutlery)})`);
  }
  for (const menu of cart.items) {
    statements.push(sql`INSERT INTO order_menu_v2(order_id,orderable_shop_menu_id,orderable_shop_menu_price_id,name,price_name,price,quantity,is_deleted)
      VALUES(${orderId},${menu.orderable_shop_menu_id},${menu.orderable_shop_menu_price_id},${menu.name},${menu.price_name},${menu.price},${menu.quantity},0)`);
    const menuId = sql`(SELECT MAX(id) FROM order_menu_v2 WHERE order_id=${orderId})`;
    for (const option of menu.options) {
      statements.push(sql`INSERT INTO order_menu_option_v2(order_menu_id,orderable_shop_menu_option_group_id,orderable_shop_menu_option_id,group_name,name,price,quantity,is_deleted)
      VALUES(${menuId},${option.option_group_id},${option.orderable_shop_menu_option_id},${option.option_group_name},${option.option_name},${option.option_price},${option.quantity},0)`);
    }
  }
  return statements;
}

/** 결제 중 장바구니가 바뀌었으면(리비전 불일치) 장바구니는 남겨 둔다. 주문은 스냅샷대로 만들어진다. */
function clearCartStatements(userId: number, cart: CartGraph): SQL[] {
  const unchanged = sql`EXISTS(SELECT 1 FROM native_commerce_revision WHERE user_id=${userId} AND revision=${cart.revision})`;
  return [
    sql`DELETE FROM cart_menu_item_option WHERE cart_menu_item_id IN(SELECT id FROM cart_menu_item WHERE cart_id=${cart.id}) AND ${unchanged}`,
    sql`DELETE FROM cart_menu_item WHERE cart_id=${cart.id} AND ${unchanged}`,
    sql`DELETE FROM cart WHERE id=${cart.id} AND ${unchanged}`,
    sql`UPDATE native_commerce_revision SET revision=revision+1 WHERE user_id=${userId} AND revision=${cart.revision}`,
  ];
}

async function finishConfirmation(db: Database, temporary: TemporaryPayment, gateway: TossPayment): Promise<number> {
  assertGatewayMatches(gateway, temporary);
  const snapshot = JSON.parse(temporary.snapshot_json) as CheckoutSnapshot;
  const method = Object.keys(paymentMethods).find((key) => paymentMethods[key] === gateway.method);
  if (!method || !gateway.orderName || !gateway.requestedAt || !gateway.approvedAt || !gateway.receipt?.url) commerceError('PAYMENT_CONFIRM_ERROR');
  const orderId = sql`(SELECT id FROM order_v2 WHERE pg_order_id=${temporary.pg_order_id})`;
  const statements: SQL[] = [
    ...orderInsertStatements(temporary, snapshot, orderId),
    sql`INSERT INTO payment_v2(order_id,payment_key,amount,status,method,description,easy_pay_company,requested_at,approved_at,receipt,is_deleted)
    VALUES(${orderId},${gateway.paymentKey},${gateway.totalAmount},'DONE',${method},${gateway.orderName},${gateway.easyPay?.provider ?? null},${sqlNow(new Date(gateway.requestedAt).getTime())},${sqlNow(new Date(gateway.approvedAt).getTime())},${gateway.receipt.url},0)`,
    ...clearCartStatements(temporary.user_id, snapshot.cart),
    sql`UPDATE temporary_payment SET status='COMPLETED',completed_order_id=${orderId},gateway_json=${JSON.stringify(gateway)},claimed_until=NULL,next_attempt_at=NULL WHERE pg_order_id=${temporary.pg_order_id}`,
  ];
  try {
    await guardedBatch(db, sql`EXISTS(SELECT 1 FROM temporary_payment WHERE pg_order_id=${temporary.pg_order_id} AND completed_order_id IS NULL AND status IN('CONFIRMING','RECONCILE'))`, statements);
  } catch (error) {
    // 다른 워커가 먼저 완료했으면 그 결제를 돌려준다.
    const existing = await first<{ id: number }>(db, sql`SELECT p.id FROM payment_v2 p JOIN order_v2 o ON o.id=p.order_id WHERE o.pg_order_id=${temporary.pg_order_id}`);
    if (existing) return existing.id;
    throw error;
  }
  return (await first<{ id: number }>(db, sql`SELECT id FROM payment_v2 WHERE order_id=${orderId}`))!.id;
}

async function recordConfirmFailure(db: Database, temporary: TemporaryPayment, error: unknown): Promise<void> {
  const uncertain = temporary.status !== 'PREPARED' || uncertainGatewayFailure(error, 'ALREADY_PROCESSED_PAYMENT');
  await db.run(sql`UPDATE temporary_payment SET status=${uncertain ? 'RECONCILE' : 'PREPARED'},claimed_until=NULL,next_attempt_at=${uncertain ? nextAttemptAt(temporary.attempts) : null},last_error=${errorMessage(error)} WHERE pg_order_id=${temporary.pg_order_id} AND status NOT IN('COMPLETED','FAILED')`);
}

/** 이미 승인 요청이 나갔을 수 있는 상태(RECONCILE/CONFIRMING)는 조회로 먼저 확인하고, 아직 미결이면 승인한다. */
async function confirmWithGateway(env: Bindings, temporary: TemporaryPayment, body: z.output<typeof confirmBody>): Promise<TossPayment> {
  const confirm = () => tossConfirm(env, { paymentKey: body.payment_key, orderId: body.order_id, amount: body.amount }, temporary.idempotency_key);
  if (temporary.status !== 'RECONCILE' && temporary.status !== 'CONFIRMING') return confirm();
  const current = await tossRetrieve(env, body.payment_key);
  return current.status === 'READY' || current.status === 'IN_PROGRESS' ? confirm() : current;
}

export async function confirmPayment(db: Database, env: Bindings, userId: number, raw: unknown) {
  const body = confirmBody.parse(raw);
  const temporary = await first<TemporaryPayment>(db, sql`SELECT * FROM temporary_payment WHERE pg_order_id=${body.order_id}`);
  if (!temporary) commerceError('NOT_FOUND_TEMPORARY_PAYMENT');
  const mismatch = temporary.user_id !== userId
    || temporary.total_price !== body.amount
    || (temporary.payment_key !== null && temporary.payment_key !== body.payment_key);
  if (mismatch) commerceError('MISMATCH_TEMPORARY_PAYMENT');
  if (temporary.status === 'COMPLETED') {
    const payment = await first<{ id: number }>(db, sql`SELECT id FROM payment_v2 WHERE order_id=${temporary.completed_order_id}`);
    if (!payment) commerceError('NOT_FOUND_PAYMENT');
    return paymentResponse(db, payment.id, userId, true);
  }
  if (temporary.status === 'FAILED') commerceError('PAYMENT_CONFIRM_ERROR');
  if (temporary.status === 'EXPIRED' || (temporary.status === 'PREPARED' && temporary.expires_at <= Date.now())) commerceError('NOT_FOUND_TEMPORARY_PAYMENT');
  const leaseUntil = leaseDeadline(env);
  const [claim] = await executeAtomic(db, [sql`UPDATE temporary_payment SET status='CONFIRMING',payment_key=${body.payment_key},claimed_until=${leaseUntil},attempts=attempts+1,next_attempt_at=${leaseUntil}
    WHERE pg_order_id=${body.order_id} AND status IN('PREPARED','RECONCILE','CONFIRMING') AND (status!='PREPARED' OR expires_at>${Date.now()}) AND (claimed_until IS NULL OR claimed_until<=${Date.now()}) RETURNING pg_order_id`]);
  if (!claim?.results?.length) throw new ApiError(409, 'PAYMENT_PROCESSING', '결제 처리 중입니다. 잠시 후 다시 조회해주세요.');
  // 임대가 끝나는 시점에 큐 작업이 깨어나 이 워커가 죽었더라도 승인 상태를 맞춘다.
  await env.JOBS.send({ kind: 'commerce.payment-confirm', key: body.order_id, payload: {} }, { delaySeconds: delaySecondsUntil(leaseUntil) });
  temporary.payment_key = body.payment_key;
  try {
    const gateway = await confirmWithGateway(env, temporary, body);
    if (FAILED_GATEWAY_STATUSES.includes(gateway.status)) {
      await db.run(sql`UPDATE temporary_payment SET status='FAILED',gateway_json=${JSON.stringify(gateway)},claimed_until=NULL,next_attempt_at=NULL WHERE pg_order_id=${body.order_id} AND status!='COMPLETED'`);
      commerceError('PAYMENT_CONFIRM_ERROR');
    }
    await db.run(sql`UPDATE temporary_payment SET gateway_json=${JSON.stringify(gateway)},status='RECONCILE' WHERE pg_order_id=${body.order_id} AND status!='COMPLETED'`);
    const paymentId = await finishConfirmation(db, temporary, gateway);
    return paymentResponse(db, paymentId, userId, true);
  } catch (error) {
    await recordConfirmFailure(db, temporary, error);
    throw error;
  }
}

async function cancelResponse(db: Database, paymentId: number) {
  const rows = await db.all<{ id: number; reason: string; amount: number; canceled_at: string }>(sql`SELECT id,reason,amount,canceled_at FROM payment_cancel_v2 WHERE payment_id=${paymentId} AND is_deleted=0 ORDER BY id`);
  return { payment_cancels: rows.map((row) => ({ id: row.id, cancel_reason: row.reason, cancel_amount: row.amount, canceled_at: kstDate(row.canceled_at) })) };
}

async function finishCancellation(db: Database, payment: PaymentOrder, attempt: CancelAttempt, gateway: TossPayment): Promise<void> {
  if (gateway.status !== 'CANCELED' || gateway.paymentKey !== payment.payment_key || gateway.totalAmount !== payment.amount || !gateway.cancels?.length) commerceError('PAYMENT_CANCEL_ERROR');
  const lastCancel = gateway.cancels[gateway.cancels.length - 1]!;
  const statements: SQL[] = [
    sql`UPDATE payment_v2 SET status='CANCELED',updated_at=CURRENT_TIMESTAMP WHERE id=${payment.id}`,
    sql`UPDATE order_v2 SET status='CANCELED',canceled_reason=${attempt.cancel_reason},canceled_at=${sqlNow(new Date(lastCancel.canceledAt).getTime())},updated_at=CURRENT_TIMESTAMP WHERE id=${payment.order_id}`,
  ];
  for (const cancellation of gateway.cancels) {
    statements.push(sql`INSERT INTO payment_cancel_v2(payment_id,transaction_key,reason,amount,canceled_at,is_deleted)
    SELECT ${payment.id},${cancellation.transactionKey},${cancellation.cancelReason},${cancellation.cancelAmount},${sqlNow(new Date(cancellation.canceledAt).getTime())},0
    WHERE NOT EXISTS(SELECT 1 FROM payment_cancel_v2 WHERE payment_id=${payment.id} AND transaction_key=${cancellation.transactionKey})`);
  }
  statements.push(sql`UPDATE native_payment_cancel_attempt SET status='COMPLETED',gateway_json=${JSON.stringify(gateway)},claimed_until=NULL,next_attempt_at=NULL WHERE payment_id=${payment.id}`);
  // 사장님 취소만 주문자에게 상태 알림을 보낸다.
  if (attempt.idempotency_key.startsWith('owner:')) {
    statements.push(outbox('commerce.order-status', `${payment.order_id}:CANCELED`, { orderId: payment.order_id, userId: payment.user_id, shopName: payment.orderable_shop_name, status: 'CANCELED', delivery: payment.order_type === 'DELIVERY', estimatedAt: null }));
  }
  try {
    await guardedBatch(db, sql`EXISTS(SELECT 1 FROM native_payment_cancel_attempt WHERE payment_id=${payment.id} AND status IN('CANCELING','RECONCILE'))`, statements);
  } catch (error) {
    const current = await first<{ status: string }>(db, sql`SELECT status FROM payment_v2 WHERE id=${payment.id}`);
    if (current?.status !== 'CANCELED') throw error;
  }
}

export async function cancelPayment(db: Database, env: Bindings, paymentId: number, userId: number, reason: string, owner = false) {
  const payment = await paymentOrder(db, paymentId);
  if (payment.status === 'CANCELED') commerceError('PAYMENT_ALREADY_CANCELED');
  if (payment.user_id !== userId) commerceError('PAYMENT_ACCESS_DENIED');
  if (!reason.trim() || reason.length > 200) commerceError('REQUIRED_ORDER_CANCEL_REASON');
  if (owner && payment.order_status !== 'CONFIRMING') commerceError('INVALID_ORDER_STATUS_CHANGE');
  const key = `${owner ? 'owner:' : 'user:'}${crypto.randomUUID()}`;
  // 실패한 시도만 새 멱등키로 덮어쓴다. 진행 중이거나 완료된 시도는 그대로 이어받는다.
  await guardedBatch(db, owner ? sql`EXISTS(SELECT 1 FROM order_v2 WHERE id=${payment.order_id} AND status='CONFIRMING')` : sql`1`, [
    sql`INSERT INTO native_payment_cancel_attempt(payment_id,user_id,idempotency_key,cancel_reason,status,attempts,created_at)
      VALUES(${paymentId},${userId},${key},${reason},'PREPARED',0,${new Date().toISOString()}) ON CONFLICT(payment_id) DO UPDATE SET status='PREPARED',idempotency_key=excluded.idempotency_key,cancel_reason=excluded.cancel_reason WHERE native_payment_cancel_attempt.status='FAILED'`,
  ]);
  const attempt = (await first<CancelAttempt>(db, sql`SELECT * FROM native_payment_cancel_attempt WHERE payment_id=${paymentId}`))!;
  if (attempt.status === 'COMPLETED') return cancelResponse(db, paymentId);
  const leaseUntil = leaseDeadline(env);
  const [claim] = await executeAtomic(db, [sql`UPDATE native_payment_cancel_attempt SET status='CANCELING',claimed_until=${leaseUntil},attempts=attempts+1,next_attempt_at=${leaseUntil}
    WHERE payment_id=${paymentId} AND status IN('PREPARED','RECONCILE','CANCELING') AND (claimed_until IS NULL OR claimed_until<=${Date.now()}) RETURNING payment_id`]);
  if (!claim?.results?.length) throw new ApiError(409, 'PAYMENT_PROCESSING', '결제 처리 중입니다. 잠시 후 다시 조회해주세요.');
  await env.JOBS.send({ kind: 'commerce.payment-cancel', key: String(paymentId), payload: {} }, { delaySeconds: delaySecondsUntil(leaseUntil) });
  const resumed = attempt.status === 'RECONCILE' || attempt.status === 'CANCELING';
  try {
    let gateway = resumed ? await tossRetrieve(env, payment.payment_key) : null;
    if (gateway?.status !== 'CANCELED') gateway = await tossCancel(env, payment.payment_key, { cancelReason: attempt.cancel_reason }, attempt.idempotency_key);
    await db.run(sql`UPDATE native_payment_cancel_attempt SET gateway_json=${JSON.stringify(gateway)},status='RECONCILE' WHERE payment_id=${paymentId} AND status!='COMPLETED'`);
    await finishCancellation(db, payment, attempt, gateway);
    return cancelResponse(db, paymentId);
  } catch (error) {
    const uncertain = resumed || uncertainGatewayFailure(error, 'ALREADY_CANCELED_PAYMENT');
    await db.run(sql`UPDATE native_payment_cancel_attempt SET status=${uncertain ? 'RECONCILE' : 'FAILED'},claimed_until=NULL,next_attempt_at=${uncertain ? nextAttemptAt(attempt.attempts) : null},last_error=${errorMessage(error)} WHERE payment_id=${paymentId} AND status!='COMPLETED'`);
    throw error;
  }
}

async function handleConfirmJob(db: Database, env: Bindings, job: Job): Promise<void> {
  const payment = await first<TemporaryPayment & { next_attempt_at: number | null }>(db, sql`SELECT * FROM temporary_payment WHERE pg_order_id=${job.key}`);
  if (!payment || !['CONFIRMING', 'RECONCILE'].includes(payment.status) || !payment.payment_key) return;
  const due = Math.max(payment.claimed_until ?? 0, payment.next_attempt_at ?? 0);
  if (due > Date.now()) {
    await env.JOBS.send(job, { delaySeconds: delaySecondsUntil(due) });
    return;
  }
  await confirmPayment(db, env, payment.user_id, { order_id: payment.pg_order_id, payment_key: payment.payment_key, amount: payment.total_price });
}

async function handleCancelJob(db: Database, env: Bindings, job: Job): Promise<void> {
  const attempt = await first<CancelAttempt & { next_attempt_at: number | null }>(db, sql`SELECT * FROM native_payment_cancel_attempt WHERE payment_id=${Number(job.key)}`);
  if (!attempt || attempt.status === 'FAILED' || attempt.status === 'PREPARED') return;
  const byOwner = attempt.idempotency_key.startsWith('owner:');
  if (attempt.status !== 'COMPLETED') {
    const due = Math.max(attempt.claimed_until ?? 0, attempt.next_attempt_at ?? 0);
    if (due > Date.now()) {
      await env.JOBS.send(job, { delaySeconds: delaySecondsUntil(due) });
      return;
    }
    await cancelPayment(db, env, attempt.payment_id, attempt.user_id, attempt.cancel_reason, byOwner);
  }
  if (byOwner) {
    const payment = await paymentOrder(db, attempt.payment_id);
    await env.JOBS.send({ kind: 'commerce.order-status', key: `commerce.order-status:${payment.order_id}:CANCELED`, payload: {} });
  }
}

export async function handlePaymentJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'commerce.payment-confirm' && job.kind !== 'commerce.payment-cancel') return false;
  const db = createDatabase(env.DB);
  if (job.kind === 'commerce.payment-confirm') await handleConfirmJob(db, env, job);
  else await handleCancelJob(db, env, job);
  return true;
}

export async function reconcilePayments(env: Bindings, now: number): Promise<void> {
  const db = createDatabase(env.DB);
  await db.run(sql`UPDATE temporary_payment SET status='EXPIRED' WHERE status='PREPARED' AND expires_at<=${now}`);
  await db.run(sql`DELETE FROM native_cart_duplicate WHERE expires_at<=${now}`);
  const confirmations = await db.all<TemporaryPayment>(sql`SELECT * FROM temporary_payment WHERE status IN('CONFIRMING','RECONCILE') AND (claimed_until IS NULL OR claimed_until<=${now}) AND (next_attempt_at IS NULL OR next_attempt_at<=${now}) ORDER BY created_at LIMIT ${RECONCILE_BATCH}`);
  const cancellations = await db.all<CancelAttempt>(sql`SELECT * FROM native_payment_cancel_attempt WHERE status IN('CANCELING','RECONCILE') AND (claimed_until IS NULL OR claimed_until<=${now}) AND (next_attempt_at IS NULL OR next_attempt_at<=${now}) ORDER BY created_at LIMIT ${RECONCILE_BATCH}`);
  const errors: unknown[] = [];
  for (const temporary of confirmations) {
    if (!temporary.payment_key) continue;
    try {
      await confirmPayment(db, env, temporary.user_id, { payment_key: temporary.payment_key, order_id: temporary.pg_order_id, amount: temporary.total_price });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const attempt of cancellations) {
    try {
      await cancelPayment(db, env, attempt.payment_id, attempt.user_id, attempt.cancel_reason, attempt.idempotency_key.startsWith('owner:'));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, '결제 상태 동기화에 실패했습니다. 다음 예약 실행에서 다시 시도합니다.');
}

export function registerPayments(app: Hono<ApiEnv>): void {
  app.post('/payments/delivery/temporary', async (c) => c.json(await createTemporaryPayment(c.get('db'), c.env, requirePrincipal(c, ['STUDENT']).id, 'DELIVERY', await c.req.json())));
  app.post('/payments/takeout/temporary', async (c) => c.json(await createTemporaryPayment(c.get('db'), c.env, requirePrincipal(c, ['STUDENT']).id, 'TAKE_OUT', await c.req.json())));
  app.post('/payments/confirm', async (c) => c.json(await confirmPayment(c.get('db'), c.env, requirePrincipal(c, ['STUDENT']).id, await c.req.json())));
  app.post('/payments/:paymentId/cancel', async (c) => {
    const user = requirePrincipal(c, ['STUDENT']);
    const body = z.object({ cancel_reason: z.string().trim().min(1).max(200) }).parse(await c.req.json());
    return c.json(await cancelPayment(c.get('db'), c.env, Number(c.req.param('paymentId')), user.id, body.cancel_reason));
  });
  app.get('/payments/:paymentId', async (c) => c.json(await paymentResponse(c.get('db'), Number(c.req.param('paymentId')), requirePrincipal(c, ['STUDENT']).id)));
}
