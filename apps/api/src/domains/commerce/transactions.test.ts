import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@api/db/client';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import { createTemporaryPayment, confirmPayment, cancelPayment, handlePaymentJob } from '@api/domains/commerce/payments';
import { guardedBatch, mutateCart, revision } from '@api/domains/commerce/storage';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../drizzle/0000_source_and_native.sql', import.meta.url), 'utf8'));
  class Statement {
    constructor(readonly query: string, readonly params: SQLInputValue[] = []) {}
    bind(...params: SQLInputValue[]) { return new Statement(this.query, params); }
    async all() { const results = sqlite.prepare(this.query).all(...this.params); return { success: true, results, meta: { changes: Number(sqlite.prepare('SELECT changes() AS count').get()!.count) } }; }
    async raw() { return sqlite.prepare(this.query).all(...this.params).map((row) => Object.values(row)); }
    async run() { return this.all(); }
  }
  const binding = { prepare(query: string) { return new Statement(query); }, async batch(statements: Statement[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = []; for (const statement of statements) result.push(await statement.all()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  sqlite.exec("INSERT INTO users(id,password,user_type,anonymous_nickname) VALUES(1,'hash','STUDENT','익명'); INSERT INTO students(user_id) VALUES(1)");
  sqlite.exec("INSERT INTO shops(id,name,internal_name,address) VALUES(1,'가게','가게','병천'); INSERT INTO orderable_shop(id,shop_id,minimum_order_amount) VALUES(1,1,10000)");
  sqlite.exec('INSERT INTO shop_operation(shop_id,is_open) VALUES(1,1)');
  sqlite.exec("INSERT INTO orderable_shop_menu(id,orderable_shop_id,name) VALUES(1,1,'볶음밥'); INSERT INTO orderable_shop_menu_price(id,orderable_shop_menu_id,price) VALUES(1,1,10000)");
  sqlite.exec('INSERT INTO cart(id,user_id,orderable_shop_id) VALUES(1,1,1); INSERT INTO cart_menu_item(id,cart_id,orderable_shop_menu_id,orderable_shop_menu_price_id,quantity) VALUES(1,1,1,1,1)');
  const signals: Job[] = [];
  const env = { DB: binding, TOSS_SECRET_KEY: 'test_secret', JOBS: { async send(job: Job) { signals.push(job); }, async sendBatch(jobs: { body: Job }[]) { signals.push(...jobs.map((job) => job.body)); } } } as unknown as Bindings;
  return { sqlite, db: createDatabase(binding), env, signals };
}

const request = { phone_number: '01012345678', provide_cutlery: false, total_menu_price: 10000, total_amount: 10000 };
function gateway(orderId: string) {
  return { paymentKey: 'payment-key', orderId, status: 'DONE', totalAmount: 10000, balanceAmount: 10000, orderName: '볶음밥', method: '카드', requestedAt: '2026-10-28T12:00:00+09:00', approvedAt: '2026-10-28T12:00:02+09:00', receipt: { url: 'https://receipt.tosspayments.com/receipt' } };
}

test('cart optimistic revisions prevent lost updates and roll back every statement on stale writers', async () => {
  const { sqlite, db } = fixture();
  try {
    const before = await revision(db, 1);
    await mutateCart(db, 1, before, [sql`UPDATE cart_menu_item SET quantity=2 WHERE id=1`]);
    await assert.rejects(mutateCart(db, 1, before, [sql`UPDATE cart_menu_item SET quantity=9 WHERE id=1`]), { code: 'CONCURRENT_MODIFICATION' });
    assert.equal(sqlite.prepare('SELECT quantity FROM cart_menu_item WHERE id=1').get()!.quantity, 2);
    assert.equal(sqlite.prepare('SELECT revision FROM native_commerce_revision WHERE user_id=1').get()!.revision, before + 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM native_commerce_guard').get()!.count, 0);
  } finally { sqlite.close(); }
});

test('database failure after gateway approval is reconciled without a second charge or partial order', async (t) => {
  const { sqlite, db, env, signals } = fixture();
  try {
    const temporary = await createTemporaryPayment(db, env, 1, 'TAKE_OUT', request);
    const methods: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { methods.push(init?.method ?? 'GET'); return Response.json(gateway(temporary.order_id)); });
    sqlite.exec("CREATE TRIGGER reject_payment BEFORE INSERT ON payment_v2 BEGIN SELECT RAISE(ABORT,'payment unavailable'); END");
    await assert.rejects(confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 }));
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM order_v2').get()!.count, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM cart').get()!.count, 1);
    assert.equal(sqlite.prepare('SELECT status FROM temporary_payment').get()!.status, 'RECONCILE');
    assert.equal(signals[0]?.kind, 'commerce.payment-confirm');
    sqlite.exec('DROP TRIGGER reject_payment');
    const first = await confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 });
    const repeated = await confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 });
    assert.deepEqual(repeated, first);
    assert.deepEqual(methods, ['POST', 'GET']);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM order_v2').get()!.count, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM payment_v2').get()!.count, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM cart').get()!.count, 0);
  } finally { sqlite.close(); }
});

test('checkout keeps charged menu snapshot and does not erase a subsequently edited cart', async (t) => {
  const { sqlite, db, env } = fixture();
  try {
    const temporary = await createTemporaryPayment(db, env, 1, 'TAKE_OUT', request);
    await mutateCart(db, 1, await revision(db, 1), [sql`UPDATE cart_menu_item SET quantity=2 WHERE id=1`]);
    t.mock.method(globalThis, 'fetch', async () => Response.json(gateway(temporary.order_id)));
    await confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 });
    assert.equal(sqlite.prepare('SELECT quantity FROM order_menu_v2').get()!.quantity, 1);
    assert.equal(sqlite.prepare('SELECT total_price FROM order_v2').get()!.total_price, 10000);
    assert.equal(sqlite.prepare('SELECT quantity FROM cart_menu_item').get()!.quantity, 2);
  } finally { sqlite.close(); }
});

test('temporary payment expiry boundary rejects before gateway call', async (t) => {
  const { sqlite, db, env } = fixture();
  try {
    const temporary = await createTemporaryPayment(db, env, 1, 'TAKE_OUT', request);
    sqlite.prepare('UPDATE temporary_payment SET expires_at=?').run(Date.now());
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not charge'); });
    await assert.rejects(confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 }), { code: 'NOT_FOUND_TEMPORARY_PAYMENT' });
    assert.equal(fetch.mock.callCount(), 0);
  } finally { sqlite.close(); }
});

test('an ambiguous confirmation remains retriable when gateway lookup also fails', async (t) => {
  const { sqlite, db, env } = fixture();
  try {
    const temporary = await createTemporaryPayment(db, env, 1, 'TAKE_OUT', request);
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network lost'); });
    await assert.rejects(confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 }));
    await assert.rejects(confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 }));
    assert.equal(sqlite.prepare('SELECT status FROM temporary_payment').get()!.status, 'RECONCILE');
    assert.ok(Number(sqlite.prepare('SELECT next_attempt_at FROM temporary_payment').get()!.next_attempt_at) > Date.now());
  } finally { sqlite.close(); }
});

test('cancellation persists no partial local status when refund records cannot commit', async (t) => {
  const { sqlite, db, env } = fixture();
  try {
    const temporary = await createTemporaryPayment(db, env, 1, 'TAKE_OUT', request);
    let canceled = false;
    t.mock.method(globalThis, 'fetch', async () => Response.json(canceled ? { ...gateway(temporary.order_id), status: 'CANCELED', balanceAmount: 0, cancels: [{ cancelAmount: 10000, cancelReason: '재료 소진', canceledAt: '2026-10-28T12:05:00+09:00', transactionKey: 'cancel-transaction' }] } : gateway(temporary.order_id)));
    const payment = await confirmPayment(db, env, 1, { payment_key: 'payment-key', order_id: temporary.order_id, amount: 10000 });
    canceled = true;
    sqlite.exec("CREATE TRIGGER reject_cancel BEFORE INSERT ON payment_cancel_v2 BEGIN SELECT RAISE(ABORT,'cancel unavailable'); END");
    await assert.rejects(cancelPayment(db, env, payment.id, 1, '재료 소진', true));
    assert.equal(sqlite.prepare('SELECT status FROM payment_v2').get()!.status, 'DONE');
    assert.equal(sqlite.prepare('SELECT status FROM order_v2').get()!.status, 'CONFIRMING');
    assert.equal(sqlite.prepare('SELECT status FROM native_payment_cancel_attempt').get()!.status, 'RECONCILE');
    await assert.rejects(guardedBatch(db, sql`NOT EXISTS(SELECT 1 FROM native_payment_cancel_attempt WHERE status IN('CANCELING','RECONCILE'))`, [sql`UPDATE order_v2 SET status='COOKING'`]), { code: 'CONCURRENT_MODIFICATION' });
    sqlite.exec('DROP TRIGGER reject_cancel; UPDATE native_payment_cancel_attempt SET next_attempt_at=0');
    await handlePaymentJob(env, { kind: 'commerce.payment-cancel', key: String(payment.id), payload: {} });
    assert.equal(sqlite.prepare('SELECT status FROM payment_v2').get()!.status, 'CANCELED');
    assert.equal(sqlite.prepare('SELECT status FROM order_v2').get()!.status, 'CANCELED');
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM payment_cancel_v2').get()!.count, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM native_commerce_outbox').get()!.count, 1);
  } finally { sqlite.close(); }
});
