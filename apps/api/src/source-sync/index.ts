import type { Hono } from 'hono';
import { ZodError } from 'zod';
import type { ApiEnv } from '@api/runtime';
import { signalOutbox } from '@api/domains/community/store';
import { applyDelta, BaselineTooLarge, Conflict, readBaseline, type Statement } from './apply';
import { canonicalKey, parseEnvelope, rowKey, type Delta } from './contract';

const MAX_BYTES = 256 * 1024;
const MAX_BASELINE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
interface State {
  checkpoint: string;
  next_page: number;
  completed: number;
}
interface Receipt {
  body_sha256: string;
  applied_rows: number;
}
function failure(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
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
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}
async function authenticate(request: Request, secret: string, body: Uint8Array): Promise<boolean> {
  const timestamp = request.headers.get('X-Source-Sync-Timestamp');
  const signature = request.headers.get('X-Source-Sync-Signature');
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const mac = Uint8Array.from(signature.match(/../g)!, (piece) => parseInt(piece, 16));
  return crypto.subtle.verify('HMAC', key, mac, signed);
}
async function sha256(body: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
function prepared(db: D1Database, statements: Statement[]): D1PreparedStatement[] {
  return statements.map(({ sql, args }) => db.prepare(sql).bind(...args));
}
function acknowledgement(payload: Delta, appliedRows: number): Response {
  return Response.json(
    {
      version: 2,
      dataset: payload.dataset,
      checkpoint: payload.checkpoint,
      page: payload.page,
      appliedRows,
      completed: true,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
export function registerSourceSync(app: Hono<ApiEnv>): void {
  app.post('/internal/source-sync', async (c) => {
    const request = c.req.raw;
    if (c.env.SOURCE_SYNC_ENABLED !== 'true') return failure(503, 'SOURCE_SYNC_DISABLED');
    if (new URL(request.url).protocol !== 'https:' && c.env.ENVIRONMENT !== 'development')
      return failure(403, 'HTTPS_REQUIRED');
    if (request.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase() !== 'application/json')
      return failure(415, 'JSON_REQUIRED');
    const secret = c.env.SOURCE_SYNC_SECRET;
    if (!secret || encoder.encode(secret).byteLength < 32) return failure(503, 'SOURCE_SYNC_DISABLED');
    let body: Uint8Array;
    try {
      body = await rawBody(request);
    } catch {
      return failure(413, 'BODY_TOO_LARGE');
    }
    if (!(await authenticate(request, secret, body))) return failure(401, 'BAD_SIGNATURE');
    let payload;
    try {
      payload = parseEnvelope(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError || error instanceof TypeError)
        return failure(400, 'INVALID_PAYLOAD');
      throw error;
    }
    const db = c.env.DB;
    if ('action' in payload) {
      let rows;
      try {
        rows = await readBaseline(db, payload.dataset, payload.keys);
      } catch (error) {
        if (error instanceof Conflict) return failure(409, error.message);
        if (error instanceof BaselineTooLarge) return failure(413, 'BASELINE_TOO_LARGE');
        throw error;
      }
      const fragments: string[] = [];
      let bytes = encoder.encode(`{"version":2,"dataset":${JSON.stringify(payload.dataset)},"rows":[]}`).byteLength;
      for (const row of rows) {
        const fragment = JSON.stringify(row);
        bytes += encoder.encode(fragment).byteLength + Number(fragments.length > 0);
        if (bytes > MAX_BASELINE_BYTES) return failure(413, 'BASELINE_TOO_LARGE');
        fragments.push(fragment);
      }
      return new Response(
        `{"version":2,"dataset":${JSON.stringify(payload.dataset)},"rows":[${fragments.join(',')}]}`,
        { headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } },
      );
    }
    const { dataset, checkpoint, page, final } = payload;
    const pageHash = await sha256(body);
    const state = await db
      .prepare('SELECT checkpoint,next_page,completed FROM native_source_sync_v2_state WHERE dataset=?')
      .bind(dataset)
      .first<State>();
    if (state && BigInt(checkpoint) <= BigInt(state.checkpoint)) {
      if (checkpoint !== state.checkpoint) return failure(409, 'STALE_CHECKPOINT');
      const receipt = await db
        .prepare(
          'SELECT body_sha256,applied_rows FROM native_source_sync_v2_receipt WHERE dataset=? AND checkpoint=? AND page=?',
        )
        .bind(dataset, checkpoint, page)
        .first<Receipt>();
      if (receipt)
        return receipt.body_sha256 === pageHash
          ? acknowledgement(payload, receipt.applied_rows)
          : failure(409, 'ALTERED_PAGE');
      if (page !== state.next_page || state.completed) return failure(409, 'REORDERED_PAGE');
    } else if (page !== 0 || state?.completed === 0) return failure(409, 'REORDERED_PAGE');
    const operations =
      new Set(payload.upserts.map((row) => canonicalKey(dataset, rowKey(dataset, row)))).size + payload.deletes.length;
    let statements: Statement[];
    try {
      statements = await applyDelta(db, payload);
    } catch (error) {
      if (error instanceof Conflict) return failure(409, error.message);
      throw error;
    }
    // The guard and every changed business row execute in one D1 batch. A losing
    // concurrent writer rolls back its entire page, including metadata.
    const expected = state?.checkpoint ?? '0';
    const next = state?.next_page ?? 0;
    const completed = state?.completed ?? 1;
    const batch: Statement[] = [
      {
        sql: `INSERT OR IGNORE INTO native_source_sync_v2_state(dataset,checkpoint,next_page,completed) VALUES(?,'0',0,1)`,
        args: [dataset],
      },
      {
        sql: `INSERT INTO native_source_sync_v2_guard(valid)
        SELECT CASE WHEN checkpoint=? AND next_page=? AND completed=? THEN 1 ELSE 0 END
        FROM native_source_sync_v2_state WHERE dataset=?`,
        args: [expected, next, completed, dataset],
      },
      ...statements,
      ...(page === 0
        ? [
            {
              sql: 'DELETE FROM native_source_sync_v2_receipt WHERE dataset=? AND checkpoint<>?',
              args: [dataset, checkpoint],
            } satisfies Statement,
          ]
        : []),
      {
        sql: 'INSERT INTO native_source_sync_v2_receipt(dataset,checkpoint,page,body_sha256,applied_rows) VALUES(?,?,?,?,?)',
        args: [dataset, checkpoint, page, pageHash, operations],
      },
      {
        sql: 'UPDATE native_source_sync_v2_state SET checkpoint=?,next_page=?,completed=? WHERE dataset=?',
        args: [checkpoint, page + 1, Number(final), dataset],
      },
      { sql: 'DELETE FROM native_source_sync_v2_guard', args: [] },
    ];
    let applied: D1Result[];
    try {
      applied = await db.batch(prepared(db, batch));
    } catch (error) {
      if (/native_source_sync_v2_guard|UNIQUE constraint|FOREIGN KEY constraint|CHECK constraint/.test(String(error)))
        return failure(409, 'SOURCE_CONFLICT');
      throw error;
    }
    if (dataset === 'articles') await signalOutbox(c.env, applied);
    return acknowledgement(payload, operations);
  });
}
