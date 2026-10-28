import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Database } from '@api/db/client';
import type { ApiEnv, Bindings } from '@api/runtime';
import { requirePrincipal } from '@api/auth';
import { extractFileKey, fileExists } from '@api/integrations';
import { atomicDining, nextId, outboxStatement } from '@api/domains/dining/store';
import { cafeteriaOpened } from '@api/domains/dining/coopshop';
import {
  actorBody, checkResult, encodeImagePath, fail, integer, kstDate, kstTimestamp, offsetTimestamp,
  pageWindow, reportResponse, requestObject, resultBody, utcSql, uuidPattern,
  type Actor, type ChangeRow, type DiningRow, type ReportRow, type ReportStatus, type ReportResponse,
} from '@api/domains/dining/protocol';

export async function getDining(db: Database, id: number): Promise<DiningRow> {
  const dining = await db.get<DiningRow>(sql`SELECT * FROM dining_menus WHERE id = ${id}`);
  if (!dining) fail('NOT_FOUND_DINING');
  return dining;
}
async function getReport(db: Database, id: number): Promise<ReportRow> {
  const report = await db.get<ReportRow>(sql`SELECT * FROM dining_soldout_report WHERE id = ${id}`);
  if (!report) fail('NOT_FOUND_DINING_REPORT');
  return report;
}
async function soldoutEvent(db: Database, dining: DiningRow, now: Date) {
  if (dining.date !== kstDate(now) || !await cafeteriaOpened(db, now, dining.type, false)) return null;
  if (await db.get(sql`SELECT 1 FROM native_dining_rate_limit WHERE key = ${`soldout:${dining.place}`} AND expires_at > ${now.toISOString()}`)) return null;
  const id = crypto.randomUUID();
  return { id, statement: outboxStatement('dining.soldout', { dining_id: dining.id, place: dining.place, type: dining.type }, now.toISOString(), id) };
}
async function appendChanges(db: Database, reports: ReportRow[], dining: DiningRow, event: 'CREATED' | 'PROCESSED', now: string): Promise<SQL[]> {
  if (!reports.length) return [];
  const row = await db.get<{ last_sequence: string }>(sql`SELECT last_sequence FROM dining_soldout_report_sequence WHERE id = 1`);
  if (!row) throw new Error('식단 제보 변경 순번 초기값이 없습니다.');
  let sequence = BigInt(row.last_sequence);
  const statements: SQL[] = [];
  for (const report of reports) {
    sequence++;
    statements.push(sql`INSERT INTO dining_soldout_report_change
      (sequence, report_id, event_type, status, processing_type, processing_id, occurred_at, delivery_id, report_snapshot, delivery_state)
      VALUES (${sequence.toString()}, ${report.id}, ${event}, ${report.status}, ${report.processing_type}, ${report.processing_id}, ${now}, ${crypto.randomUUID()}, ${JSON.stringify(reportResponse(report, dining))}, 'QUEUED')`);
  }
  statements.push(sql`UPDATE dining_soldout_report_sequence SET last_sequence = ${sequence.toString()} WHERE id = 1`);
  return statements;
}
async function validateImage(env: Bindings, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) fail('INVALID_REQUEST_BODY');
  let key: string;
  try {
    key = extractFileKey(env, value);
    if (value.includes('?') || value.includes('#') || !key.startsWith('upload/COOP/') || key.endsWith('/')) fail('INVALID_REPORT_IMAGE');
  } catch { fail('INVALID_REPORT_IMAGE'); }
  let exists: boolean;
  try { exists = await fileExists(env, key); } catch { fail('IMAGE_STORAGE_UNAVAILABLE'); }
  if (!exists) fail('INVALID_REPORT_IMAGE');
  return value;
}
export async function createReport(db: Database, env: Bindings, reporter: number, diningId: number, imageUrl: unknown, clock = () => new Date()) {
  const image = await validateImage(env, imageUrl);
  return atomicDining(db, async () => {
    const dining = await getDining(db, diningId);
    const existing = await db.get(sql`SELECT id FROM dining_soldout_report WHERE dining_id = ${diningId} AND reporter_id = ${reporter}`);
    if (existing) fail('DINING_REPORT_ALREADY_SUBMITTED');
    const now = clock();
    if (dining.date !== kstDate(now)) fail('DINING_REPORT_DATE_NOT_ALLOWED');
    if (dining.sold_out !== null) fail('DINING_ALREADY_SOLD_OUT');
    const timestamp = utcSql(now);
    const id = await nextId(db, 'dining_soldout_report');
    const report: ReportRow = { id, dining_id: diningId, reporter_id: reporter, image_url: image, status: 'PENDING', processing_type: null, processing_id: null, source_report_id: null, processor_workspace_id: null, processor_user_id: null, processor_name: null, processed_at: null, created_at: timestamp, updated_at: timestamp };
    return {
      statements: [sql`INSERT INTO dining_soldout_report (id, dining_id, reporter_id, image_url, status, created_at, updated_at) VALUES (${id}, ${diningId}, ${reporter}, ${image}, 'PENDING', ${timestamp}, ${timestamp})`, ...await appendChanges(db, [report], dining, 'CREATED', timestamp)],
      value: { report_id: id, status: 'PENDING', created_at: kstTimestamp(timestamp) },
    };
  });
}
function processReport(report: ReportRow, result: Exclude<ReportStatus, 'PENDING'>, batchId: string, source: number | null, timestamp: string, actor: Actor | null): ReportRow {
  return { ...report, status: result, processing_type: actor ? 'MANUAL' : source === null ? 'COOP_PREPROCESSED' : 'SAME_DINING_APPROVED', processing_id: batchId, source_report_id: source, processed_at: timestamp, updated_at: timestamp, processor_workspace_id: actor?.workspace_id ?? null, processor_user_id: actor?.user_id ?? null, processor_name: actor?.display_name ?? null };
}
function updateReport(report: ReportRow): SQL {
  return sql`UPDATE dining_soldout_report SET status = ${report.status}, processing_type = ${report.processing_type}, processing_id = ${report.processing_id}, source_report_id = ${report.source_report_id}, processor_workspace_id = ${report.processor_workspace_id}, processor_user_id = ${report.processor_user_id}, processor_name = ${report.processor_name}, processed_at = ${report.processed_at}, updated_at = ${report.updated_at} WHERE id = ${report.id} AND status = 'PENDING'`;
}
export async function decideReport(db: Database, id: number, actor: Actor, result: 'APPROVED' | 'REJECTED', clock = () => new Date(), env?: Bindings) {
  return atomicDining(db, async () => {
    const target = await getReport(db, id);
    const dining = await getDining(db, target.dining_id);
    const reports = await db.all<ReportRow>(sql`SELECT * FROM dining_soldout_report WHERE dining_id = ${dining.id} ORDER BY id`);
    if (target.status !== 'PENDING') {
      if (target.status !== result) fail('DINING_REPORT_ALREADY_PROCESSED');
      return { statements: [], value: { report: reportResponse(target, dining, true), affected_report_ids: reports.filter((report) => report.processing_id === target.processing_id).map((report) => report.id), already_processed: true } };
    }
    const now = clock();
    const timestamp = utcSql(now);
    const batchId = crypto.randomUUID();
    const affected = (result === 'APPROVED' ? reports.filter((report) => report.status === 'PENDING') : [target])
      .map((report) => processReport(report, result, batchId, report.id === id ? null : id, timestamp, report.id === id ? actor : null));
    const statements = affected.map(updateReport);
    const outboxIds: string[] = [];
    if (result === 'APPROVED' && dining.sold_out === null) {
      statements.push(sql`UPDATE dining_menus SET sold_out = ${timestamp}, sold_out_source = 'REPORT', updated_at = ${timestamp} WHERE id = ${dining.id} AND sold_out IS NULL`);
      const event = await soldoutEvent(db, dining, now);
      if (event) { outboxIds.push(event.id); statements.push(event.statement); }
    }
    statements.push(...await appendChanges(db, affected, dining, 'PROCESSED', timestamp));
    return { statements, outboxIds, value: { report: reportResponse(affected.find((report) => report.id === id)!, dining, true), affected_report_ids: affected.map((report) => report.id), already_processed: false } };
  }, env);
}
export async function changeSoldout(db: Database, diningId: number, soldout: boolean, clock = () => new Date(), env?: Bindings): Promise<void> {
  await atomicDining(db, async () => {
    const dining = await getDining(db, diningId);
    const now = clock();
    const timestamp = utcSql(now);
    if (!soldout) return { statements: [sql`UPDATE dining_menus SET sold_out = NULL, sold_out_source = NULL, updated_at = ${timestamp} WHERE id = ${diningId}`], value: undefined };
    const pending = await db.all<ReportRow>(sql`SELECT * FROM dining_soldout_report WHERE dining_id = ${diningId} AND status = 'PENDING' ORDER BY id`);
    const batchId = crypto.randomUUID();
    const affected = pending.map((report) => processReport(report, 'REJECTED', batchId, null, timestamp, null));
    const statements = affected.map(updateReport);
    const outboxIds: string[] = [];
    if (dining.sold_out === null) {
      statements.push(sql`UPDATE dining_menus SET sold_out = ${timestamp}, sold_out_source = 'COOP', updated_at = ${timestamp} WHERE id = ${diningId} AND sold_out IS NULL`);
      const event = await soldoutEvent(db, dining, now);
      if (event) { outboxIds.push(event.id); statements.push(event.statement); }
    }
    statements.push(...await appendChanges(db, affected, dining, 'PROCESSED', timestamp));
    return { statements, outboxIds, value: undefined };
  }, env);
}
export async function claimDelivery(db: Database, clock = () => new Date()) {
  return atomicDining(db, async () => {
    const now = clock();
    const timestamp = utcSql(now, true);
    const change = await db.get<ChangeRow>(sql`SELECT c.* FROM dining_soldout_report_change c WHERE
      ((c.delivery_state = 'QUEUED' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ${timestamp}))
        OR (c.delivery_state = 'IN_PROGRESS' AND c.expires_at <= ${timestamp}))
      AND NOT EXISTS (SELECT 1 FROM dining_soldout_report_change earlier WHERE earlier.report_id = c.report_id
        AND CAST(earlier.sequence AS INTEGER) < CAST(c.sequence AS INTEGER) AND earlier.delivery_state <> 'DELIVERED')
      ORDER BY CAST(c.sequence AS INTEGER) LIMIT 1`);
    if (!change) return { statements: [], value: null };
    let snapshot = change.report_snapshot;
    if (snapshot === null) {
      const report = await getReport(db, change.report_id);
      snapshot = JSON.stringify(reportResponse(report, await getDining(db, report.dining_id)));
    }
    const delivery = change.delivery_id ?? crypto.randomUUID();
    const token = crypto.randomUUID();
    const expiry = utcSql(new Date(now.getTime() + 60_000), true);
    const body = JSON.parse(snapshot) as ReportResponse;
    body.image_url = encodeImagePath(body.image_url);
    return {
      statements: [sql`UPDATE dining_soldout_report_change SET delivery_id = ${delivery}, report_snapshot = ${snapshot}, attempt_token = ${token}, expires_at = ${expiry}, next_attempt_at = NULL, accepted_outcome = NULL, delivery_state = 'IN_PROGRESS' WHERE sequence = ${change.sequence}`],
      value: { delivery_id: delivery, attempt_token: token, expires_at: offsetTimestamp(expiry), report: body },
    };
  });
}
export async function recordDeliveryResult(db: Database, deliveryId: string, body: unknown, clock = () => new Date()) {
  const request = resultBody(body);
  return atomicDining(db, async () => {
    const change = await db.get<ChangeRow>(sql`SELECT * FROM dining_soldout_report_change WHERE delivery_id = ${deliveryId}`);
    if (!change) fail('NOT_FOUND_DINING_REPORT_DELIVERY');
    const other = request.attempt_token !== change.attempt_token
      ? await db.get(sql`SELECT 1 FROM dining_soldout_report_change WHERE attempt_token = ${request.attempt_token} AND delivery_id <> ${deliveryId}`) : undefined;
    if (checkResult(change, request.attempt_token, request.outcome, Boolean(other))) return { statements: [], value: { delivery_id: deliveryId, delivery_state: change.delivery_state } };
    const state = request.outcome === 'SUCCEEDED' ? 'DELIVERED' : 'QUEUED';
    const next = state === 'QUEUED' ? utcSql(new Date(clock().getTime() + 5_000), true) : null;
    return { statements: [sql`UPDATE dining_soldout_report_change SET accepted_outcome = ${request.outcome}, delivery_state = ${state}, next_attempt_at = ${next} WHERE delivery_id = ${deliveryId} AND attempt_token = ${request.attempt_token}`], value: { delivery_id: deliveryId, delivery_state: state } };
  });
}
async function botAuth(c: Context<ApiEnv>): Promise<void> {
  const expected = c.env.DINING_REPORT_BOT_TOKEN;
  const actual = c.req.header('X-Koin-Service-Token');
  if (!expected?.trim() || !actual?.trim()) fail('BOT_AUTHENTICATION_FAILED');
  // 길이가 다른 토큰도 같은 시간에 비교되도록 해시 다이제스트끼리 상수 시간으로 비교한다.
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(expected)), crypto.subtle.digest('SHA-256', encoder.encode(actual))]);
  const expectedDigest = new Uint8Array(left);
  const actualDigest = new Uint8Array(right);
  let mismatch = 0;
  for (let index = 0; index < expectedDigest.length; index++) mismatch |= expectedDigest[index]! ^ actualDigest[index]!;
  if (mismatch) fail('BOT_AUTHENTICATION_FAILED');
}
export function registerDiningReports(app: Hono<ApiEnv>): void {
  app.post('/dinings/:diningId/soldout-reports', async (c) => {
    const reporter = requirePrincipal(c, ['STUDENT']);
    const body = requestObject(await c.req.json());
    return c.json(await createReport(c.get('db'), c.env, reporter.id, integer(c.req.param('diningId')), body.image_url), 201);
  });
  app.use('/internal/dining/soldout-reports/*', async (c, next) => {
    await botAuth(c);
    await next();
  });
  app.post('/internal/dining/soldout-reports/deliveries/claim', async (c) => {
    const claim = await claimDelivery(c.get('db'));
    if (!claim) {
      c.header('Retry-After', '5');
      return c.body(null, 204);
    }
    return c.json(claim);
  });
  app.post('/internal/dining/soldout-reports/deliveries/:deliveryId/result', async (c) => {
    const id = c.req.param('deliveryId');
    if (!uuidPattern.test(id)) fail('ILLEGAL_ARGUMENT');
    return c.json(await recordDeliveryResult(c.get('db'), id.toLowerCase(), await c.req.json()));
  });
  app.post('/internal/dining/soldout-reports/:reportId/approve', async (c) => c.json(await decideReport(c.get('db'), integer(c.req.param('reportId')), actorBody(await c.req.json()), 'APPROVED', undefined, c.env)));
  app.post('/internal/dining/soldout-reports/:reportId/reject', async (c) => c.json(await decideReport(c.get('db'), integer(c.req.param('reportId')), actorBody(await c.req.json()), 'REJECTED', undefined, c.env)));
  app.get('/internal/dining/soldout-reports/:reportId', async (c) => {
    const report = await getReport(c.get('db'), integer(c.req.param('reportId')));
    return c.json(reportResponse(report, await getDining(c.get('db'), report.dining_id), true));
  });
  app.get('/admin/dining/soldout-reports', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const pending = c.req.query('only_pending') === 'true';
    const where = pending ? sql`status = 'PENDING'` : sql`1 = 1`;
    const total = (await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM dining_soldout_report WHERE ${where}`))!.total;
    const page = pageWindow(integer(c.req.query('page') ?? 1), integer(c.req.query('limit') ?? 10), total);
    const reports = await db.all<ReportRow>(sql`SELECT * FROM dining_soldout_report WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${page.size} OFFSET ${page.offset}`);
    const details = await Promise.all(reports.map(async (report) => {
      const response = reportResponse(report, await getDining(db, report.dining_id));
      return { report_id: response.report_id, dining: response.dining, status: response.status, processing_type: response.processing_type, reason: response.reason, created_at: response.created_at, processed_at: response.processed_at, processor: response.processor };
    }));
    return c.json({ reports: details, total_count: total, current_count: details.length, total_page: page.totalPage, current_page: page.currentPage });
  });
  app.get('/admin/dining/soldout-reports/:reportId', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const report = await getReport(db, integer(c.req.param('reportId')));
    const user = report.reporter_id === null ? null : await db.get<{ id: number; name: string | null; nickname: string | null }>(sql`SELECT id, name, nickname FROM users WHERE id = ${report.reporter_id}`);
    return c.json({ ...reportResponse(report, await getDining(db, report.dining_id)), reporter: user ? { id: user.id, name: user.name?.trim() ? user.name : user.nickname?.trim() ? user.nickname : '회원' } : null });
  });
}
