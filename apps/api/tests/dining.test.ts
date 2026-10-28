import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import { createDatabase, executeAtomic } from '@api/db/client';
import type { ApiEnv, Bindings } from '@api/runtime';
import { ApiError, errorResponse } from '@api/errors';
import { claimDelivery, createReport, decideReport, changeSoldout, recordDeliveryResult, registerDiningReports } from '@api/domains/dining/reports';
import { createCoopSemester, openedAt } from '@api/domains/dining/coopshop';
import { encodeImagePath, kstDate, resultBody, type DiningRow } from '@api/domains/dining/protocol';
import { diningWorkbook, parseCoopWorkbook } from '@api/domains/dining/spreadsheets';
import { handleDiningJob } from '@api/domains/dining/jobs';
import type { Job } from '@api/jobs';

class LocalStatement {
  constructor(readonly database: DatabaseSync, readonly query: string, readonly parameters: (string | number | null | Uint8Array)[] = []) {}
  bind(...parameters: (string | number | null | Uint8Array)[]) { return new LocalStatement(this.database, this.query, parameters); }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async first(column?: string) { const row = this.execute().results[0]; return column && row ? row[column] : row ?? null; }
  async raw() { return this.execute().results.map((row) => Object.values(row)); }
  execute() {
    const statement = this.database.prepare(this.query);
    const results = statement.columns().length ? statement.all(...this.parameters) : [];
    const change = statement.columns().length ? { changes: 0, lastInsertRowid: 0 } : statement.run(...this.parameters);
    return { success: true, results, meta: { changes: Number(change.changes), last_row_id: Number(change.lastInsertRowid), duration: 0, rows_read: results.length, rows_written: Number(change.changes), changed_db: true, size_after: 0 } };
  }
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT OR IGNORE INTO dining_soldout_report_sequence (id, last_sequence) VALUES (1, '0');
    INSERT INTO users (id, password, user_type, anonymous_nickname) VALUES (1,'hash','STUDENT','a'),(2,'hash','STUDENT','b'),(3,'hash','STUDENT','c');
    INSERT INTO dining_menus (id,date,type,place,menu) VALUES (1,'2026-10-02','LUNCH','A코너','["돈까스"]'),(2,'2026-10-02','LUNCH','B코너','["국수"]');`);
  sqlite.exec(`INSERT INTO coop_semester (id,semester,from_date,to_date,is_applied) VALUES (1,'26-2학기','2026-09-01','2026-12-31',1);
    INSERT INTO coop_names (id,name) VALUES (1,'학생식당');
    INSERT INTO coop_shop (id,semester_id,coop_name_id,location) VALUES (1,1,1,'학생식당');
    INSERT INTO coop_opens (coop_shop_id,type,day_of_week,open_time,close_time) VALUES (1,'점심','WEEKDAYS','00:00','23:59');`);
  const binding = {
    prepare: (query: string) => new LocalStatement(sqlite, query),
    batch: async (statements: LocalStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  const db = createDatabase(binding);
  const env = { DB: binding, R2_FILES_PUBLIC_URL: 'https://static.koreatech.in/', FILES: { head: async () => ({ key: 'object' }) } } as unknown as Bindings;
  const clock = { value: new Date('2026-10-02T03:00:00.551Z') };
  return { sqlite, db, env, clock, now: () => clock.value, close: () => sqlite.close() };
}
const image = 'https://static.koreatech.in/upload/COOP/품절 photo+100%20.jpg';
const actor = { workspace_id: 'T_TEST', user_id: 'U_TEST', display_name: '담당자' };
const errorCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test('concurrent creates allocate a single globally ordered sequence and concurrent approvals preserve the processing group', async () => {
  const f = fixture();
  try {
    const reports = await Promise.all([createReport(f.db, f.env, 1, 1, image, f.now), createReport(f.db, f.env, 2, 1, image, f.now), createReport(f.db, f.env, 3, 2, image, f.now)]);
    assert.deepEqual(f.sqlite.prepare('SELECT sequence FROM dining_soldout_report_change ORDER BY CAST(sequence AS INTEGER)').all().map((row) => row.sequence), ['1', '2', '3']);
    const [first, second] = await Promise.all([decideReport(f.db, reports[0]!.report_id, actor, 'APPROVED', f.now), decideReport(f.db, reports[1]!.report_id, actor, 'APPROVED', f.now)]);
    assert.equal(Number(first.already_processed) + Number(second.already_processed), 1);
    assert.deepEqual(first.affected_report_ids, second.affected_report_ids);
    assert.equal(first.affected_report_ids.length, 2);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM dining_soldout_report_change').get()!.n, 5);
    assert.equal(f.sqlite.prepare('SELECT last_sequence FROM dining_soldout_report_sequence').get()!.last_sequence, '5');
    await assert.rejects(decideReport(f.db, reports[0]!.report_id, actor, 'REJECTED', f.now), errorCode('DINING_REPORT_ALREADY_PROCESSED'));
  } finally { f.close(); }
});

test('transaction failure rolls back report insertion, sequence allocation, guard and change rows together', async () => {
  const f = fixture();
  try {
    await assert.rejects(executeAtomic(f.db, [sql`UPDATE dining_menus SET sold_out = '2026-10-02 03:00:00' WHERE id = 1`, sql`INSERT INTO dining_menus (id,date,type,place,menu) VALUES (1,'2026-10-02','LUNCH','A코너','[]')`]));
    assert.equal(f.sqlite.prepare('SELECT sold_out FROM dining_menus WHERE id=1').get()!.sold_out, null);
    f.sqlite.exec(`CREATE TRIGGER fail_report_change BEFORE INSERT ON dining_soldout_report_change BEGIN SELECT RAISE(ABORT,'forced change failure'); END`);
    await assert.rejects(createReport(f.db, f.env, 1, 1, image, f.now), /forced change failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM dining_soldout_report').get()!.n, 0);
    assert.equal(f.sqlite.prepare('SELECT last_sequence FROM dining_soldout_report_sequence').get()!.last_sequence, '0');
    assert.equal(f.sqlite.prepare("SELECT version FROM native_dining_guard WHERE id='global'").get()!.version, 0);
  } finally { f.close(); }
});

test('delivery snapshots remain frozen, only one concurrent claim wins, and late success unlocks only its own successor', async () => {
  const f = fixture();
  try {
    const report = await createReport(f.db, f.env, 1, 1, image, f.now);
    await decideReport(f.db, report.report_id, actor, 'APPROVED', f.now);
    const claims = await Promise.all([claimDelivery(f.db, f.now), claimDelivery(f.db, f.now)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const created = claims.find((claim) => claim !== null)!;
    assert.equal(created.report.status, 'PENDING');
    assert.equal(created.report.image_url, encodeImagePath(image));
    f.clock.value = new Date(f.clock.value.getTime() + 61_000);
    const success = { attempt_token: created.attempt_token, outcome: 'SUCCEEDED' };
    assert.equal((await recordDeliveryResult(f.db, created.delivery_id, success, f.now)).delivery_state, 'DELIVERED');
    const processed = (await claimDelivery(f.db, f.now))!;
    assert.equal(processed.report.status, 'APPROVED');
    assert.notEqual(processed.delivery_id, created.delivery_id);
    await recordDeliveryResult(f.db, created.delivery_id, success, f.now);
    assert.equal(f.sqlite.prepare('SELECT delivery_state FROM dining_soldout_report_change WHERE delivery_id=?').get(processed.delivery_id)!.delivery_state, 'IN_PROGRESS');
  } finally { f.close(); }
});

test('lease is claimable at exactly 60 seconds; replacement fences old tokens and cross-delivery tokens return 404', async () => {
  const f = fixture();
  try {
    await createReport(f.db, f.env, 1, 1, image, f.now);
    await createReport(f.db, f.env, 2, 2, image, f.now);
    const first = (await claimDelivery(f.db, f.now))!;
    const second = (await claimDelivery(f.db, f.now))!;
    f.clock.value = new Date(f.clock.value.getTime() + 59_999);
    assert.equal(await claimDelivery(f.db, f.now), null);
    f.clock.value = new Date(f.clock.value.getTime() + 1);
    const replacement = (await claimDelivery(f.db, f.now))!;
    assert.equal(replacement.delivery_id, first.delivery_id);
    assert.notEqual(replacement.attempt_token, first.attempt_token);
    await assert.rejects(recordDeliveryResult(f.db, first.delivery_id, { attempt_token: first.attempt_token, outcome: 'SUCCEEDED' }, f.now), errorCode('DINING_REPORT_DELIVERY_CONFLICT'));
    await assert.rejects(recordDeliveryResult(f.db, first.delivery_id, { attempt_token: second.attempt_token, outcome: 'SUCCEEDED' }, f.now), errorCode('NOT_FOUND_DINING_REPORT_DELIVERY'));
  } finally { f.close(); }
});

test('failed result retry waits exactly five seconds and duplicate acknowledgements never extend it', async () => {
  const f = fixture();
  try {
    await createReport(f.db, f.env, 1, 1, image, f.now);
    const claim = (await claimDelivery(f.db, f.now))!;
    const body = { attempt_token: claim.attempt_token, outcome: 'FAILED' };
    assert.equal((await recordDeliveryResult(f.db, claim.delivery_id, body, f.now)).delivery_state, 'QUEUED');
    f.clock.value = new Date(f.clock.value.getTime() + 4_999);
    await recordDeliveryResult(f.db, claim.delivery_id, body, f.now);
    assert.equal(await claimDelivery(f.db, f.now), null);
    f.clock.value = new Date(f.clock.value.getTime() + 1);
    assert.equal((await claimDelivery(f.db, f.now))!.delivery_id, claim.delivery_id);
    await assert.rejects(recordDeliveryResult(f.db, claim.delivery_id, body, f.now), errorCode('DINING_REPORT_DELIVERY_CONFLICT'));
  } finally { f.close(); }
});

test('coop soldout auto-rejects pending reports; cancellation never reopens reports or permits a second report', async () => {
  const f = fixture();
  try {
    const report = await createReport(f.db, f.env, 1, 1, image, f.now);
    await changeSoldout(f.db, 1, true, f.now);
    await changeSoldout(f.db, 1, false, f.now);
    const stored = f.sqlite.prepare('SELECT * FROM dining_soldout_report WHERE id=?').get(report.report_id)!;
    assert.equal(stored.status, 'REJECTED');
    assert.equal(stored.processing_type, 'COOP_PREPROCESSED');
    assert.equal(stored.processor_user_id, null);
    await assert.rejects(createReport(f.db, f.env, 1, 1, image, f.now), errorCode('DINING_REPORT_ALREADY_SUBMITTED'));
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM dining_soldout_report_change').get()!.n, 2);
  } finally { f.close(); }
});

test('KST midnight, path encoding, strict result fields and specific weekday overrides match source boundaries', () => {
  assert.equal(kstDate(new Date('2026-10-02T14:59:59Z')), '2026-10-02');
  assert.equal(kstDate(new Date('2026-10-02T15:00:00Z')), '2026-10-03');
  assert.equal(encodeImagePath(image), 'https://static.koreatech.in/upload/COOP/%ED%92%88%EC%A0%88%20photo%2B100%2520.jpg');
  assert.throws(() => resultBody({ attempt_token: crypto.randomUUID(), outcome: 'SUCCEEDED', extra: null }), errorCode('INVALID_REQUEST_BODY'));
  const rows = [{ day_of_week: 'WEEKDAYS', type: '점심', open_time: '11:00', close_time: '13:00' }, { day_of_week: 'FRIDAY', type: '아침', open_time: '07:00', close_time: '09:00' }];
  assert.equal(openedAt(rows, new Date('2026-10-02T03:00:00Z'), 'LUNCH', false), false);
  assert.equal(openedAt(rows.slice(0, 1), new Date('2026-10-02T04:00:00Z'), 'LUNCH', false), true);
  assert.equal(openedAt(rows.slice(0, 1), new Date('2026-10-02T04:00:00.001Z'), 'LUNCH', false), false);
});

test('empty service token denies internal APIs even when caller supplies an empty header', async () => {
  const app = new Hono<ApiEnv>();
  app.onError((error) => error instanceof ApiError ? errorResponse(error) : Response.json({}, { status: 500 }));
  registerDiningReports(app);
  const response = await app.request('/internal/dining/soldout-reports/deliveries/claim', { method: 'POST', headers: { 'X-Koin-Service-Token': '' } }, { DINING_REPORT_BOT_TOKEN: '' } as Bindings);
  assert.equal(response.status, 401);
  assert.equal((await response.json() as { code: string }).code, 'BOT_AUTHENTICATION_FAILED');
});

test('native XLSX export places menu/image/kcal/soldout correctly and import expands merged cells', () => {
  const dining: DiningRow = { id: 1, date: '2026-10-02', type: 'LUNCH', place: 'A코너', price_card: 5000, price_cash: 5000, kcal: 700, menu: '["돈까스", "밥"]', image_url: image, created_at: '2026-10-02 03:00:00', updated_at: '2026-10-02 03:00:00', sold_out: null, sold_out_source: null, is_changed: null, likes: 0 };
  const book = XLSX.read(diningWorkbook([dining], true), { type: 'array' });
  assert.equal(book.Sheets['식단']!['C14'].v, '돈까스\n밥');
  assert.equal(book.Sheets['식단']!['C15'].v, image);
  assert.equal(book.Sheets['식단']!['C16'].v, '700 kcal');
  assert.equal(book.Sheets['식단']!['C17'].v, '미품절');
  const input = XLSX.utils.aoa_to_sheet([[], [], ['학생식당','평일','아침','07:00','09:00','041','휴일 휴무','학생회관'], [null,null,'점심','11:00','13:00',null,null,null]]);
  input['!merges'] = [0,1,5,6,7].map((c) => ({ s: { r: 2, c }, e: { r: 3, c } }));
  const inputBook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(inputBook, input, '시간표');
  const result = parseCoopWorkbook(new Uint8Array(XLSX.write(inputBook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.operation_hours.length, 2);
  assert.equal(result[0]!.operation_hours[1]!.day_of_week, '평일');
});

test('concurrent coop semester creation rejects inclusive overlapping boundaries atomically', async () => {
  const f = fixture();
  try {
    f.sqlite.exec('DELETE FROM coop_opens; DELETE FROM coop_shop; DELETE FROM coop_names; DELETE FROM coop_semester;');
    const results = await Promise.allSettled([
      createCoopSemester(f.db, { semester: '26-1학기', from_date: '2026-03-02', to_date: '2026-06-19' }),
      createCoopSemester(f.db, { semester: '26-여름학기', from_date: '2026-06-19', to_date: '2026-08-30' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failure = results.find((result) => result.status === 'rejected');
    assert.equal(failure?.status === 'rejected' && errorCode('OVERLAPPING_SEMESTER_DATE_RANGE')(failure.reason), true);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM coop_semester').get()!.n, 1);
    assert.equal(f.sqlite.prepare('SELECT is_applied FROM coop_semester').get()!.is_applied, 0);
  } finally { f.close(); }
});

test('soldout outbox signals immediately and concurrent same-place events fan out only once during the two-hour throttle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-02T03:00:00.551Z') });
  const f = fixture();
  const signals: Job[] = [];
  f.env.JOBS = { sendBatch: async (messages: { body: Job }[]) => { signals.push(...messages.map((message) => message.body)); } } as unknown as Queue<Job>;
  try {
    f.sqlite.exec(`UPDATE users SET device_token='device' WHERE id=1;
      INSERT INTO notification_subscribe (id,user_id,subscribe_type,detail_type,created_at,updated_at) VALUES ('1',1,'DINING_SOLD_OUT','LUNCH','2026-10-02 03:00:00','2026-10-02 03:00:00');`);
    await changeSoldout(f.db, 1, true, f.now, f.env);
    await changeSoldout(f.db, 1, false, f.now, f.env);
    await changeSoldout(f.db, 1, true, f.now, f.env);
    assert.equal(signals.length, 2);
    await Promise.all(signals.slice().map((job) => handleDiningJob(f.env, job)));
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM native_dining_outbox WHERE kind='dining.push'").get()!.n, 1);
    assert.equal(signals.length, 3);
    assert.equal(f.sqlite.prepare("SELECT expires_at FROM native_dining_rate_limit WHERE key='soldout:A코너'").get()!.expires_at, '2026-10-02T05:00:00.551Z');
    assert.equal(f.sqlite.prepare("SELECT delivered_at FROM native_dining_outbox WHERE kind='dining.push'").get()!.delivered_at, null);
  } finally { f.close(); }
});
