import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import { executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  beginGuard, body, endGuard, enumeration, eventStatement, fail, gate, getPost, getUser, guardedId,
  integer, localDateTime, object, pagination, queryInteger, signalEvents, utcText,
  type EventType, type ProcessType, type Report,
} from '@api/domains/callvan/core';
import { processStatements } from '@api/domains/callvan/state';

export interface ReportInput {
  reported_user_id: number;
  description: string | null;
  reasons: { reason_code: string; custom_text: string | null }[];
  attachments: { attachment_type: 'IMAGE'; url: string }[];
}

export function reportInput(value: Record<string, unknown>): ReportInput {
  const reported = integer(value.reported_user_id);
  if (value.description != null && typeof value.description !== 'string') fail('INVALID_REQUEST_BODY');
  if (!Array.isArray(value.reasons) || value.reasons.length === 0) fail('INVALID_REQUEST_BODY');
  const seen = new Set<string>();
  const reasons = value.reasons.map((raw) => {
    const item = object(raw);
    const reason = enumeration(item.reason_code, ['NO_SHOW', 'NON_PAYMENT', 'PROFANITY', 'OTHER']);
    if (seen.has(reason)) fail('INVALID_REQUEST_BODY');
    seen.add(reason);
    if (item.custom_text != null && (typeof item.custom_text !== 'string' || item.custom_text.length > 150)) fail('INVALID_REQUEST_BODY');
    const custom = typeof item.custom_text === 'string' ? item.custom_text.trim() : '';
    if (reason === 'OTHER' ? !custom : !!custom) fail('INVALID_REQUEST_BODY');
    return { reason_code: reason, custom_text: reason === 'OTHER' ? custom : null };
  });
  const rawAttachments = value.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 10) fail('INVALID_REQUEST_BODY');
  const attachments = rawAttachments.map((raw) => {
    const item = object(raw);
    const type = enumeration(item.attachment_type, ['IMAGE'] as const);
    if (typeof item.url !== 'string' || !item.url.trim() || item.url.trim().length > 500) fail('INVALID_REQUEST_BODY');
    return { attachment_type: type, url: item.url.trim() };
  });
  return { reported_user_id: reported, description: typeof value.description === 'string' ? value.description.trim() || null : null, reasons, attachments };
}

function participated(postId: number, userId: number): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.callvan_participant} WHERE post_id = ${postId} AND member_id = ${userId})`;
}

function pendingReport(postId: number, reporterId: number, reportedId: number): SQL {
  return sql`EXISTS (SELECT 1 FROM ${schema.callvan_report} WHERE callvan_post_id = ${postId} AND reporter_id = ${reporterId} AND reported_id = ${reportedId} AND status IN ('PENDING', 'UNDER_REVIEW') AND is_deleted = 0)`;
}

export function registerReports(app: Hono<ApiEnv>): void {
  app.get('/callvan/restriction', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const row = await c.get('db').get<{ process_type: string; restricted_until: string | null }>(sql`SELECT rp.process_type, rp.restricted_until FROM ${schema.callvan_report_process} rp JOIN ${schema.callvan_report} r ON r.id = rp.report_id WHERE r.reported_id = ${userId} AND r.is_deleted = 0 AND rp.is_deleted = 0 AND (rp.process_type = 'PERMANENT_RESTRICTION' OR (rp.process_type = 'TEMPORARY_RESTRICTION_14_DAYS' AND julianday(rp.restricted_until) >= julianday(${utcText()}))) ORDER BY CASE WHEN rp.process_type = 'PERMANENT_RESTRICTION' THEN 0 ELSE 1 END, rp.created_at DESC, rp.id DESC LIMIT 1`);
    return c.json({ is_restricted: !!row, restriction_type: row?.process_type ?? null, restricted_until: localDateTime(row?.restricted_until ?? null) });
  });

  app.post('/callvan/posts/:postId/reports', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const coordinated = await coordinateRequest(c, `callvan:${postId}`);
    if (coordinated) return coordinated;
    const input = reportInput(await body(c));
    const db = c.get('db');
    await getPost(db, postId);
    await getUser(db, userId);
    await getUser(db, input.reported_user_id);
    if (userId === input.reported_user_id) fail('CALLVAN_REPORT_SELF');
    const membership = sql`${participated(postId, userId)} AND ${participated(postId, input.reported_user_id)}`;
    if (!(await db.get<{ valid: number }>(sql`SELECT ${membership} AS valid`))?.valid) fail('CALLVAN_REPORT_ONLY_PARTICIPANT');
    const duplicate = pendingReport(postId, userId, input.reported_user_id);
    if ((await db.get<{ present: number }>(sql`SELECT ${duplicate} AS present`))?.present) fail('CALLVAN_REPORT_ALREADY_PENDING');
    const key = crypto.randomUUID();
    const now = utcText();
    const statements = [
      beginGuard(key, sql`${membership} AND NOT ${duplicate} AND EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND is_deleted = 0)`),
      sql`INSERT INTO ${schema.callvan_report} (callvan_post_id, reporter_id, reported_id, description, status, is_deleted, created_at, updated_at) SELECT ${postId}, ${userId}, ${input.reported_user_id}, ${input.description}, 'PENDING', 0, ${now}, ${now} WHERE ${gate(key)}`,
      sql`UPDATE ${schema.native_callvan_guard} SET entity_id = last_insert_rowid() WHERE id = ${key}`,
      ...input.reasons.map((reason) => sql`INSERT INTO ${schema.callvan_report_reason} (report_id, reason_code, custom_text, is_deleted, created_at, updated_at) SELECT ${guardedId(key)}, ${reason.reason_code}, ${reason.custom_text}, 0, ${now}, ${now} WHERE ${gate(key)}`),
      ...input.attachments.map((attachment) => sql`INSERT INTO ${schema.callvan_report_attachment} (report_id, attachment_type, url, is_deleted, created_at, updated_at) SELECT ${guardedId(key)}, ${attachment.attachment_type}, ${attachment.url}, 0, ${now}, ${now} WHERE ${gate(key)}`),
      endGuard(key),
    ];
    const result = await executeAtomic(db, statements);
    if (!result[0]?.meta.changes) {
      await getPost(db, postId);
      if (!(await db.get<{ valid: number }>(sql`SELECT ${membership} AS valid`))?.valid) fail('CALLVAN_REPORT_ONLY_PARTICIPANT');
      fail('CALLVAN_REPORT_ALREADY_PENDING');
    }
    return c.body(null, 201);
  });

  app.get('/admin/callvan/reports', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const pending = enumeration(c.req.query('only_pending') ?? 'false', ['true', 'false']) === 'true';
    const condition = pending ? sql`r.status = 'PENDING'` : sql`r.status IN ('PENDING', 'CONFIRMED', 'REJECTED')`;
    const total = (await db.get<{ count: number }>(sql`SELECT count(*) AS count FROM ${schema.callvan_report} r WHERE r.is_deleted = 0 AND ${condition}`))!.count;
    const paging = pagination(queryInteger(c, 'page'), queryInteger(c, 'limit'), total);
    const current = await db.all<Report & { name: string | null; nickname: string | null }>(sql`SELECT r.*, u.name, u.nickname FROM ${schema.callvan_report} r LEFT JOIN ${schema.users} u ON u.id = r.reported_id WHERE r.is_deleted = 0 AND ${condition} ORDER BY r.created_at DESC, r.id DESC LIMIT ${paging.limit} OFFSET ${paging.offset}`);
    if (!current.length) return c.json({ reports: [], total_count: total, current_count: 0, total_page: paging.pages, current_page: paging.page });
    const reportedIds = sql.join([...new Set(current.map((report) => report.reported_id))].map((id) => sql`${id}`), sql`, `);
    const histories = await db.all<Report>(sql`SELECT * FROM ${schema.callvan_report} WHERE reported_id IN (${reportedIds}) AND is_deleted = 0 AND status IN ('PENDING', 'CONFIRMED', 'REJECTED') ORDER BY created_at DESC, id DESC`);
    const ids = sql.join(histories.map((report) => sql`${report.id}`), sql`, `);
    const [reasons, attachments, processes] = await Promise.all([
      db.all<{ report_id: number; reason_code: string; custom_text: string | null }>(sql`SELECT report_id, reason_code, custom_text FROM ${schema.callvan_report_reason} WHERE report_id IN (${ids}) AND is_deleted = 0 ORDER BY id`),
      db.all<{ report_id: number; url: string }>(sql`SELECT report_id, url FROM ${schema.callvan_report_attachment} WHERE report_id IN (${ids}) AND is_deleted = 0 ORDER BY id`),
      db.all<{ report_id: number; process_type: string; restricted_until: string | null }>(sql`SELECT report_id, process_type, restricted_until FROM ${schema.callvan_report_process} WHERE report_id IN (${ids}) AND is_deleted = 0 ORDER BY id`),
    ]);
    const reasonMap = new Map<number, { reason_code: string; custom_text: string | null }[]>();
    for (const reason of reasons) {
      const list = reasonMap.get(reason.report_id) ?? [];
      list.push({ reason_code: reason.reason_code, custom_text: reason.custom_text });
      reasonMap.set(reason.report_id, list);
    }
    const attachmentMap = new Map<number, string[]>();
    for (const attachment of attachments) {
      const list = attachmentMap.get(attachment.report_id) ?? [];
      list.push(attachment.url);
      attachmentMap.set(attachment.report_id, list);
    }
    // 처리 이력은 id순으로 읽었으므로 신고당 첫 처리만 남는다.
    const processMap = new Map<number, typeof processes[number]>();
    for (const process of processes) if (!processMap.has(process.report_id)) processMap.set(process.report_id, process);
    const historyMap = new Map<number, Report[]>();
    for (const report of histories) {
      const list = historyMap.get(report.reported_id) ?? [];
      list.push(report);
      historyMap.set(report.reported_id, list);
    }
    const historyResponse = (report: Report) => ({
      report_id: report.id,
      reported_at: localDateTime(report.created_at),
      report_status: report.status,
      process_type: processMap.get(report.id)?.process_type ?? null,
      restricted_until: localDateTime(processMap.get(report.id)?.restricted_until ?? null),
      reasons: reasonMap.get(report.id) ?? [],
    });
    return c.json({
      reports: current.map((report) => {
        const historiesForUser = historyMap.get(report.reported_id) ?? [];
        return { ...historyResponse(report), reported_user: { id: report.reported_id, name: report.name, nickname: report.nickname }, description: report.description, attachment_urls: attachmentMap.get(report.id) ?? [], accumulated_report_count: historiesForUser.length, accumulated_reports: historiesForUser.filter((item) => item.id !== report.id).map(historyResponse) };
      }), total_count: total, current_count: current.length, total_page: paging.pages, current_page: paging.page,
    });
  });

  app.post('/admin/callvan/reports/:reportId/process', async (c) => {
    const adminId = requirePrincipal(c, ['ADMIN']).id;
    const reportId = integer(c.req.param('reportId'));
    const coordinated = await coordinateRequest(c, `callvan:report:${reportId}`);
    if (coordinated) return coordinated;
    const input = await body(c);
    const type = enumeration<ProcessType>(input.process_type, ['WARNING', 'TEMPORARY_RESTRICTION_14_DAYS', 'PERMANENT_RESTRICTION', 'REJECT']);
    const db = c.get('db');
    const report = await db.get<Report>(sql`SELECT * FROM ${schema.callvan_report} WHERE id = ${reportId} AND is_deleted = 0`);
    if (!report) fail('NOT_FOUND_CALLVAN_REPORT');
    if (report.status !== 'PENDING') fail('CALLVAN_REPORT_ALREADY_PROCESSED');
    await getUser(db, adminId);
    const nowMs = Date.now();
    const now = utcText(nowMs);
    const until = type === 'TEMPORARY_RESTRICTION_14_DAYS' ? utcText(nowMs + 14 * 86_400_000) : null;
    const key = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const statements = processStatements(key, reportId, adminId, type, now, until);
    if (type !== 'REJECT') {
      if (report.callvan_post_id === null) fail('NOT_FOUND_ARTICLE');
      await getPost(db, report.callvan_post_id);
      await getUser(db, report.reported_id);
      const notificationType: EventType = type === 'WARNING' ? 'REPORT_WARNING' : type === 'PERMANENT_RESTRICTION' ? 'REPORT_PERMANENT_RESTRICTION' : 'REPORT_RESTRICTION_14_DAYS';
      statements.push(eventStatement(key, eventId, report.callvan_post_id, notificationType, { recipient_id: report.reported_id }, now));
    }
    statements.push(endGuard(key));
    const result = await executeAtomic(db, statements);
    if (!result[0]?.meta.changes) fail('CALLVAN_REPORT_ALREADY_PROCESSED');
    if (type !== 'REJECT') await signalEvents(c.env, [eventId]);
    return c.body(null, 200);
  });
}
