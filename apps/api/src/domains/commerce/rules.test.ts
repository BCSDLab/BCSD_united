import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGatewayMatches } from '@api/domains/commerce/payments';
import {
  itemAmount,
  kstDate,
  money,
  requireTransition,
  resolveOptions,
  sameConfiguration,
} from '@api/domains/commerce/rules';
import { periodStart } from '@api/domains/commerce/orders';
import { orderNotification } from '@api/domains/commerce/jobs';

test('KRW total includes each selected option per menu quantity without floating point rounding', () => {
  assert.equal(itemAmount(10900, [{ option_price: 500 }, { option_price: 1000 }], 3), 37200);
  assert.throws(() => money(0.1), { code: 'ORDER_PRICE_MISMATCH' });
  assert.throws(() => itemAmount(2_147_483_647, [{ option_price: 1 }], 1), { code: 'ORDER_PRICE_MISMATCH' });
  assert.throws(() => itemAmount(1000, [], 0), { code: 'INVALID_CART_ITEM_QUANTITY' });
});

test('option group membership and min/max counts cannot be bypassed by another group id', () => {
  const groups = [
    { id: 1, is_required: true, min_select: 1, max_select: 1 },
    { id: 2, is_required: false, min_select: 0, max_select: null },
  ];
  const options = [
    { id: 10, orderable_shop_menu_option_group_id: 1 },
    { id: 11, orderable_shop_menu_option_group_id: 1 },
    { id: 20, orderable_shop_menu_option_group_id: 2 },
  ];
  assert.throws(() => resolveOptions(groups, options, []), { code: 'REQUIRED_OPTION_GROUP_MISSING' });
  assert.throws(() => resolveOptions(groups, options, [{ option_id: 10, option_group_id: 2 }]), {
    code: 'INVALID_OPTION_IN_GROUP',
  });
  assert.throws(
    () =>
      resolveOptions(groups, options, [
        { option_id: 10, option_group_id: 1 },
        { option_id: 11, option_group_id: 1 },
      ]),
    { code: 'MAX_SELECTION_EXCEEDED' },
  );
  assert.deepEqual(
    resolveOptions(groups, options, [
      { option_id: 10, option_group_id: 1 },
      { option_id: 20, option_group_id: 2 },
    ]),
    [options[0], options[2]],
  );
});

test('cart merge compares option multiplicity and ignores selection order', () => {
  assert.equal(sameConfiguration(1, 1, [3, 2], 1, 1, [2, 3]), true);
  assert.equal(sameConfiguration(1, 1, [2, 2], 1, 1, [2, 3]), false);
  assert.equal(sameConfiguration(1, 1, [2], 1, 2, [2]), false);
});

test('order transitions exclude delivery states from takeout and reject late owner cancellation', () => {
  requireTransition('CONFIRMING', 'COOKING', 'DELIVERY');
  requireTransition('COOKING', 'PACKAGED', 'TAKE_OUT');
  requireTransition('PACKAGED', 'PICKED_UP', 'TAKE_OUT');
  assert.throws(() => requireTransition('COOKING', 'CANCELED', 'DELIVERY'), { code: 'INVALID_ORDER_STATUS_CHANGE' });
  assert.throws(() => requireTransition('COOKING', 'DELIVERING', 'TAKE_OUT'), { code: 'INVALID_ORDER_STATUS_CHANGE' });
  assert.throws(() => requireTransition('CONFIRMING', 'DELIVERED', 'DELIVERY'), {
    code: 'INVALID_ORDER_STATUS_CHANGE',
  });
});

test('gateway amount order id and payment key must all match durable checkout', () => {
  const checkout = { pg_order_id: 'order', payment_key: 'key', total_price: 10000 };
  const gateway = { orderId: 'order', paymentKey: 'key', totalAmount: 10000, status: 'DONE' };
  assertGatewayMatches(gateway, checkout);
  assert.throws(() => assertGatewayMatches({ ...gateway, totalAmount: 10001 }, checkout), {
    code: 'MISMATCH_TEMPORARY_PAYMENT',
  });
  assert.throws(() => assertGatewayMatches({ ...gateway, paymentKey: 'other' }, checkout), {
    code: 'MISMATCH_TEMPORARY_PAYMENT',
  });
  assert.throws(() => assertGatewayMatches({ ...gateway, status: 'WAITING_FOR_DEPOSIT' }, checkout), {
    code: 'PAYMENT_CONFIRM_ERROR',
  });
});

test('history period clamps month end and rendered times use KST regardless of host timezone', () => {
  assert.equal(periodStart(new Date('2026-05-31T03:00:00Z'), 3), '2026-02-28 03:00:00.000');
  assert.equal(kstDate('2026-10-27 15:01:00'), '2026.10.28 00:01');
  assert.equal(
    orderNotification({
      orderId: 7,
      userId: 1,
      shopName: '가게',
      status: 'COOKING',
      delivery: false,
      estimatedAt: '2026-10-27 15:01:00',
    }).message,
    '가게에서 조리를 시작했어요.\n포장 완료 예정: 10월 28일 00:01',
  );
});
