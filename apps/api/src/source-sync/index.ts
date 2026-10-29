import type { Hono } from 'hono';
import { ZodError } from 'zod';
import type { ApiEnv } from '@api/runtime';
import { signalOutbox } from '@api/domains/community/store';
import { ngrams } from '@api/domains/community/search';
import { applyStatements, type Statement } from './apply';
import { parseEnvelope, type SourceEnvelope } from './contract';

const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const PAGE_ACK_SQL = `SELECT p.body_sha256,
  (SELECT COALESCE(sum(q.row_count),0) FROM native_source_sync_page q
    WHERE q.dataset=p.dataset AND q.checkpoint=p.checkpoint AND q.page<=p.page) staged_rows
  FROM native_source_sync_page p WHERE p.dataset=? AND p.checkpoint=? AND p.page=?`;
interface PageAck { body_sha256: string; staged_rows: number }
interface State {
  checkpoint: string;
  stage_checkpoint: string | null;
  next_page: number;
  staged_rows: number;
  stage_final: number;
  total_rows: number | null;
  applied_rows: number;
  completed_page: number;
}
function failure(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}
function response(payload: SourceEnvelope, stagedRows: number, appliedRows: number, completed: boolean): Response {
  return Response.json({ version: 1, dataset: payload.dataset, checkpoint: payload.checkpoint, page: payload.page, stagedRows, appliedRows, completed }, { headers: { 'Cache-Control': 'no-store' } });
}
async function rawBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new RangeError('oversize');
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError('empty body');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new RangeError('oversize');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}
async function authenticate(request: Request, secret: string, body: Uint8Array): Promise<boolean> {
  const timestamp = request.headers.get('X-Source-Sync-Timestamp');
  const signature = request.headers.get('X-Source-Sync-Signature');
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const mac = Uint8Array.from(signature.match(/../g)!, (piece) => parseInt(piece, 16));
  return crypto.subtle.verify('HMAC', key, mac, signed);
}
async function sha256(body: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function prepared(db: D1Database, statements: Statement[]): D1PreparedStatement[] {
  return statements.map(({ sql, args }) => db.prepare(sql).bind(...args));
}
export function registerSourceSync(app: Hono<ApiEnv>): void {
  app.post('/internal/source-sync', async (c) => {
    const request = c.req.raw;
    if (new URL(request.url).protocol !== 'https:' && c.env.ENVIRONMENT !== 'development') return failure(403, 'HTTPS_REQUIRED');
    if (request.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() !== 'application/json') return failure(415, 'JSON_REQUIRED');
    const secret = c.env.SOURCE_SYNC_SECRET;
    if (!secret || encoder.encode(secret).byteLength < 32) return failure(503, 'SOURCE_SYNC_DISABLED');
    let body: Uint8Array;
    try { body = await rawBody(request); } catch { return failure(413, 'BODY_TOO_LARGE'); }
    if (!(await authenticate(request, secret, body))) return failure(401, 'BAD_SIGNATURE');
    let payload: SourceEnvelope;
    let rawText: string;
    try {
      rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
      payload = parseEnvelope(rawText);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError || error instanceof TypeError) return failure(400, 'INVALID_PAYLOAD');
      throw error;
    }
    const { dataset, checkpoint, page, rows, final, totalRows } = payload;
    const db = c.env.DB;
    const pageHash = await sha256(body);
    const state = await db.prepare('SELECT checkpoint,stage_checkpoint,next_page,staged_rows,stage_final,total_rows,applied_rows,completed_page FROM native_source_sync_state WHERE dataset=?').bind(dataset).first<State>();
    if (state && BigInt(checkpoint) <= BigInt(state.checkpoint)) {
      if (checkpoint !== state.checkpoint) return failure(409, 'STALE_CHECKPOINT');
      const saved = await db.prepare(PAGE_ACK_SQL).bind(dataset, checkpoint, page).first<PageAck>();
      return saved?.body_sha256 === pageHash ? response(payload, saved.staged_rows, state.applied_rows, true) : failure(409, 'ALTERED_PAGE');
    }
    if (state?.stage_checkpoint === checkpoint && page < state.next_page) {
      const saved = await db.prepare(PAGE_ACK_SQL).bind(dataset, checkpoint, page).first<PageAck>();
      if (saved?.body_sha256 !== pageHash) return failure(409, 'ALTERED_PAGE');
      if (!final) return response(payload, saved.staged_rows, 0, false);
    } else {
      if ((state?.stage_final && state.stage_checkpoint === checkpoint) || (page !== 0 && (state?.stage_checkpoint !== checkpoint || state.next_page !== page)) ||
          (state?.stage_checkpoint && BigInt(checkpoint) < BigInt(state.stage_checkpoint))) return failure(409, 'REORDERED_PAGE');
      if (final && totalRows !== (page === 0 && state?.stage_checkpoint !== checkpoint ? 0 : state?.staged_rows ?? 0) + rows.length) return failure(409, 'COUNT_MISMATCH');
      const fresh = page === 0 && state?.stage_checkpoint !== checkpoint;
      const previous = state?.stage_checkpoint ?? null;
      const count = fresh ? 0 : state?.staged_rows ?? 0;
      const statements: Statement[] = [
        { sql: 'INSERT OR IGNORE INTO native_source_sync_state(dataset) VALUES(?)', args: [dataset] },
        { sql: 'INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN checkpoint=? AND stage_checkpoint IS ? AND next_page=? AND (stage_final=0 OR ?=1) THEN 1 ELSE 0 END FROM native_source_sync_state WHERE dataset=?', args: [state?.checkpoint ?? '0', previous, state?.next_page ?? 0, Number(fresh), dataset] },
      ];
      if (fresh) {
        statements.push(
          { sql: 'DELETE FROM native_source_sync_page WHERE dataset=? AND checkpoint<>?', args: [dataset, state?.checkpoint ?? '0'] },
          { sql: 'DELETE FROM native_source_sync_row WHERE dataset=?', args: [dataset] },
          { sql: 'DELETE FROM native_source_sync_article_gram WHERE checkpoint=?', args: [previous ?? ''] },
        );
      }
      statements.push({ sql: 'INSERT INTO native_source_sync_page(dataset,checkpoint,page,body_sha256,row_count) VALUES(?,?,?,?,?)', args: [dataset,checkpoint,page,pageHash,rows.length] });
      statements.push({
        sql: `INSERT INTO native_source_sync_row(dataset,checkpoint,ordinal,payload)
          SELECT ?,?,?+CAST(j.key AS INTEGER),json(j.value) FROM json_each(?,'$.rows') j`,
        args: [dataset,checkpoint,count,rawText],
      });
      if (dataset === 'articles') {
        const grams = rows.map((row) => {
          if (!row || typeof row !== 'object' || !('title' in row) || typeof row.title !== 'string')
            throw new TypeError('Validated source article is missing its title');
          return ngrams(row.title);
        });
        statements.push({
          sql: `INSERT INTO native_source_sync_article_gram(checkpoint,ordinal,grams)
            SELECT ?,?+CAST(j.key AS INTEGER),json(j.value) FROM json_each(?) j`,
          args: [checkpoint,count,JSON.stringify(grams)],
        });
      }
      statements.push({ sql: 'UPDATE native_source_sync_state SET stage_checkpoint=?,next_page=?,staged_rows=?,stage_final=?,total_rows=? WHERE dataset=?', args: [checkpoint,page+1,count+rows.length,Number(final),totalRows ?? null,dataset] });
      statements.push({ sql: 'DELETE FROM native_source_sync_guard', args: [] });
      try { await db.batch(prepared(db, statements)); }
      catch (error) { if (String(error).includes('native_source_sync_guard') || String(error).includes('UNIQUE constraint')) return failure(409, 'CONCURRENT_PAGE'); throw error; }
      if (!final) return response(payload, count+rows.length, 0, false);
    }
    const guarded: Statement[] = [
      { sql: 'INSERT INTO native_source_sync_guard(valid) SELECT CASE WHEN stage_checkpoint=? AND checkpoint<? AND stage_final=1 AND next_page=? AND staged_rows=total_rows THEN 1 ELSE 0 END FROM native_source_sync_state WHERE dataset=?', args: [checkpoint,checkpoint,page+1,dataset] },
      ...applyStatements(dataset, checkpoint),
      { sql: 'UPDATE native_source_sync_state SET checkpoint=?,stage_checkpoint=NULL,stage_final=0,applied_rows=staged_rows,completed_page=? WHERE dataset=?', args: [checkpoint,page,dataset] },
      { sql: 'DELETE FROM native_source_sync_row WHERE dataset=? AND checkpoint=?', args: [dataset,checkpoint] },
      { sql: 'DELETE FROM native_source_sync_page WHERE dataset=? AND checkpoint<>?', args: [dataset,checkpoint] },
      { sql: 'DELETE FROM native_source_sync_guard', args: [] },
    ];
    let applied: D1Result[];
    try { applied = await db.batch(prepared(db, guarded)); }
    catch (error) {
      if (String(error).includes('native_source_sync_guard') || String(error).includes('UNIQUE constraint') || String(error).includes('FOREIGN KEY constraint')) return failure(409, 'SOURCE_CONFLICT');
      throw error;
    }
    if (dataset === 'articles') await signalOutbox(c.env, applied);
    return response(payload, totalRows!, totalRows!, true);
  });
}
