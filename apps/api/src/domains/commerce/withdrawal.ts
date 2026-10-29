import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import { first } from '@api/domains/commerce/storage';

export async function buildCommerceWithdrawal(db: Database, userId: number): Promise<SQL[]> {
  const pending = await first<{ count: number }>(
    db,
    sql`SELECT
    (SELECT count(*) FROM temporary_payment WHERE user_id=${userId} AND status IN('CONFIRMING','RECONCILE'))+
    (SELECT count(*) FROM native_payment_cancel_attempt WHERE user_id=${userId} AND status IN('CANCELING','RECONCILE')) AS count`,
  );
  if (pending?.count)
    throw new ApiError(
      409,
      'PAYMENT_PROCESSING',
      '결제 처리 중에는 탈퇴할 수 없습니다. 결제 결과 확인 후 다시 시도해주세요.',
    );
  const guard = crypto.randomUUID();
  return [
    sql`INSERT INTO native_commerce_guard(id,valid) SELECT ${guard},CASE WHEN
      NOT EXISTS(SELECT 1 FROM temporary_payment WHERE user_id=${userId} AND status IN('CONFIRMING','RECONCILE'))
      AND NOT EXISTS(SELECT 1 FROM native_payment_cancel_attempt WHERE user_id=${userId} AND status IN('CANCELING','RECONCILE')) THEN 1 ELSE 0 END`,
    sql`DELETE FROM cart_menu_item_option WHERE cart_menu_item_id IN(SELECT ci.id FROM cart_menu_item ci JOIN cart c ON c.id=ci.cart_id WHERE c.user_id=${userId})`,
    sql`DELETE FROM cart_menu_item WHERE cart_id IN(SELECT id FROM cart WHERE user_id=${userId})`,
    sql`DELETE FROM cart WHERE user_id=${userId}`,
    sql`DELETE FROM user_delivery_address WHERE user_id=${userId}`,
    sql`DELETE FROM native_commerce_guard WHERE id=${guard}`,
  ];
}
