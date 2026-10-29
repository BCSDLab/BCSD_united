import type { Hono } from 'hono';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { registerAddressDelivery } from '@api/domains/commerce/address-delivery';
import { registerCart } from '@api/domains/commerce/cart';
import {
  handleCommerceCatalogJob,
  registerCommerceCatalog,
  runCommerceCatalogCron,
} from '@api/domains/commerce/catalog';
import { handleOrderJob, runOrderCron } from '@api/domains/commerce/jobs';
import { registerOrderableCatalog } from '@api/domains/commerce/orderable-catalog';
import { registerOrders } from '@api/domains/commerce/orders';
import { handlePaymentJob, registerPayments } from '@api/domains/commerce/payments';

export function registerCommerce(app: Hono<ApiEnv>): void {
  registerCommerceCatalog(app);
  registerOrderableCatalog(app);
  registerAddressDelivery(app);
  registerCart(app);
  registerOrders(app);
  registerPayments(app);
}

export async function handleCommerceJob(env: Bindings, job: Job): Promise<boolean> {
  return (
    (await handlePaymentJob(env, job)) || (await handleOrderJob(env, job)) || (await handleCommerceCatalogJob(env, job))
  );
}

export async function runCommerceCron(env: Bindings, scheduledTime: number): Promise<void> {
  const results = await Promise.allSettled([
    runOrderCron(env, scheduledTime),
    runCommerceCatalogCron(env, scheduledTime),
  ]);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, '상점 예약 작업 처리에 실패했습니다.');
}
