import { sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Database } from '@api/db/client';
import type { ApiEnv, Bindings } from '@api/runtime';
import { ApiError } from '@api/errors';

const KST_OFFSET_MS = 9 * 3600000;
const JOB_BATCH = 100;

export async function rows<T>(db: Database, statement: SQL): Promise<T[]> {
  return db.all<T>(statement);
}

export async function first<T>(db: Database, statement: SQL): Promise<T | undefined> {
  return (await rows<T>(db, statement))[0];
}

export function invalid(message: string): never {
  throw new ApiError(400, 'INVALID_REQUEST', message);
}

/** 부호 있는 32비트 정수를 받는다. 누락된 값에만 기본값을 적용하며, 양수 제약은 호출자가 검사한다. */
export function integer(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^-?\d+$/.test(value)) return invalid('올바른 정수 값을 입력해주세요.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < -2147483648 || result > 2147483647)
    return invalid('올바른 정수 값을 입력해주세요.');
  return result;
}

/** `total`을 주면 마지막 페이지를 넘는 `page`를 마지막 페이지로 당긴다. */
export function paging(c: Context<ApiEnv>, total?: number) {
  const limit = Math.min(50, Math.max(1, integer(c.req.query('limit'), 10)));
  let page = Math.max(1, integer(c.req.query('page'), 1));
  if (total !== undefined) page = Math.min(page, Math.max(1, Math.ceil(total / limit)));
  return { page, limit, offset: (page - 1) * limit };
}

export function pageResult<T>(values: T[], total: number, page: number, limit: number) {
  return {
    articles: values,
    total_count: total,
    current_count: values.length,
    total_page: Math.ceil(total / limit),
    current_page: page,
  };
}

export function kstDate(value: string): string {
  const stamp = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return new Date(stamp + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function enumValue<T extends string>(value: string | undefined, choices: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!choices.includes(value as T)) return invalid('올바른 값을 입력해주세요.');
  return value as T;
}

/** 아웃박스 행을 `RETURNING id,kind`로 돌려주므로 배치 결과를 그대로 `signalOutbox`에 넘길 수 있다. */
export function outbox(kind: string, payload: unknown): SQL {
  return sql`INSERT INTO native_community_outbox(id,kind,payload,created_at) VALUES (${crypto.randomUUID()},${kind},${JSON.stringify(payload)},${Date.now()}) RETURNING id,kind`;
}

export async function signalOutbox(env: Bindings, results: D1Result[]) {
  const messages = results
    .flatMap((result) => result.results)
    .filter(
      (row): row is { id: string; kind: string } =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        'kind' in row &&
        typeof row.id === 'string' &&
        typeof row.kind === 'string' &&
        row.kind.startsWith('community.'),
    )
    .map((row) => ({ body: { kind: row.kind, key: row.id, payload: {} } }));
  for (let start = 0; start < messages.length; start += JOB_BATCH)
    await env.JOBS.sendBatch(messages.slice(start, start + JOB_BATCH));
}
