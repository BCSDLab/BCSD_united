import { sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { requirePrincipal } from '@api/auth';
import { createDatabase, executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';

export type CatalogContext = Context<ApiEnv>;
export type Shop = typeof schema.shops.$inferSelect;
export type Menu = typeof schema.shop_menus.$inferSelect;
export type JsonObject = Record<string, unknown>;

const KST_OFFSET_MS = 9 * 3600000;
const JOB_BATCH = 100;

/** `created_at`/`updated_at` 컬럼 형식(`YYYY-MM-DD HH:MM:SS.sss`, UTC)이다. */
export const catalogNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

export const kstDate = (now = Date.now()) => new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);

/** DB의 UTC 타임스탬프를 응답용 KST 문자열(`YYYY-MM-DD HH:MM:SS`)로 바꾼다. */
export function catalogDateTime(value: string): string {
  const utc = value.includes('T') ? value : value.replace(' ', 'T');
  const instant = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(utc) ? utc : `${utc}Z`);
  return new Date(instant + KST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** Java `LocalDate.MIN`으로 저장된 값은 KST 변환 없이 그대로 돌려준다. */
export function catalogDate(value: string): string {
  return value.startsWith('-999999999') ? '-999999999-01-01' : catalogDateTime(value).slice(0, 10);
}

export function signalCatalogJobs(c: CatalogContext, jobs: { kind: string; key: string; dueAt?: number }[]): void {
  if (!jobs.length) return;
  c.executionCtx.waitUntil(
    (async () => {
      for (let offset = 0; offset < jobs.length; offset += JOB_BATCH) {
        await c.env.JOBS.sendBatch(
          jobs.slice(offset, offset + JOB_BATCH).map((job) => ({
            body: { kind: job.kind, key: job.key, payload: {} },
            delaySeconds: Math.max(0, Math.ceil(((job.dueAt ?? Date.now()) - Date.now()) / 1000)),
          })),
        );
      }
    })(),
  );
}

export function catalogError(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

export function invalid(field: string, message: string): never {
  throw new ApiError(400, 'INVALID_REQUEST_BODY', message, [{ field, message }]);
}

export function integer(value: unknown, field = 'id', min = 1): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min)
    invalid(field, `${field} 값이 올바르지 않습니다.`);
  return parsed;
}

export function text(value: unknown, field: string, min = 1, max = 65535): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    invalid(field, `${field} 값이 올바르지 않습니다.`);
  return value;
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, `${field} 값은 필수입니다.`);
  return value;
}

export function array(value: unknown, field: string, min = 0, max = 10000): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(field, `${field} 개수가 올바르지 않습니다.`);
  return value;
}

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('body', '객체를 입력해주세요.');
  return value as JsonObject;
}

export async function body(c: CatalogContext): Promise<JsonObject> {
  try {
    return object(await c.req.json());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalid('body', 'JSON 형식이 올바르지 않습니다.');
  }
}

export function strings(value: unknown, field: string, max = 10000): string[] {
  const result = array(value, field, 0, max).map((item) => text(item, field));
  if (new Set(result).size !== result.length) invalid(field, '중복될 수 없습니다.');
  return result;
}

export function ids(value: unknown, field: string, min = 0): number[] {
  const result = array(value, field, min).map((item) => integer(item, field));
  if (new Set(result).size !== result.length) invalid(field, '중복될 수 없습니다.');
  return result;
}

export async function rows<T>(c: CatalogContext, query: SQL): Promise<T[]> {
  return c.get('db').all<T>(query);
}

/**
 * 문장들을 한 배치로 실행한다. `condition`을 주면 배치 맨 앞에서 `native_commerce_guard`의 CHECK 제약으로
 * 평가해, 거짓이면 배치 전체가 롤백되고 409 `OPTIMISTIC_LOCKING_FAILURE`가 된다.
 * 반환값은 가드 문장을 뺀 `statements`의 결과만이다.
 */
export async function atomic(env: Bindings, statements: SQL[], condition?: SQL): Promise<D1Result[]> {
  if (!condition) return executeAtomic(createDatabase(env.DB), statements);
  const guardId = crypto.randomUUID();
  try {
    const result = await executeAtomic(createDatabase(env.DB), [
      sql`insert into ${schema.native_commerce_guard} (id,valid) values (${guardId},case when ${condition} then 1 else 0 end)`,
      ...statements,
      sql`delete from ${schema.native_commerce_guard} where id=${guardId}`,
    ]);
    return result.slice(1, -1);
  } catch (error) {
    if (String(error).includes('native_commerce_guard_check_0'))
      catalogError(409, 'OPTIMISTIC_LOCKING_FAILURE', '이미 처리된 요청입니다.');
    throw error;
  }
}

/** 사장님 요청에서만 소유권 가드를 건다. 관리자 요청은 `undefined`로 가드 없이 실행한다. */
export function ownerCondition(c: CatalogContext, shopId: number): SQL | undefined {
  const principal = c.get('principal');
  if (principal?.userType !== 'OWNER') return undefined;
  return sql`exists(select 1 from ${schema.shops} where id=${shopId} and owner_id=${principal.id} and is_deleted=0)`;
}

export async function shop(c: CatalogContext, id: number, owner = false): Promise<Shop> {
  const principal = owner ? requirePrincipal(c, ['OWNER']) : null;
  const [result] = await rows<Shop>(c, sql`select * from ${schema.shops} where id=${id} and is_deleted=0`);
  if (!result) catalogError(404, '', `존재하지 않는 상점입니다. shopId: ${id}`);
  if (principal && result.owner_id !== principal.id) catalogError(403, '', `권한이 없습니다. ownerId: ${principal.id}`);
  return result;
}

export async function menu(c: CatalogContext, id: number, owner = false): Promise<Menu> {
  if (owner) requirePrincipal(c, ['OWNER']);
  const [result] = await rows<Menu>(c, sql`select * from ${schema.shop_menus} where id=${id}`);
  if (!result) catalogError(404, '', `존재하지 않는 메뉴입니다. menuId: ${id}`);
  if (owner) await shop(c, result.shop_id, true);
  return result;
}

export function outbox(kind: string, payload: JsonObject, dueAt = Date.now(), id = crypto.randomUUID()): SQL {
  return sql`insert into ${schema.native_catalog_outbox} (id,kind,payload,due_at) values (${id},${kind},${JSON.stringify(payload)},${dueAt}) on conflict(id) do update set payload=excluded.payload,due_at=excluded.due_at,delivered_at=null`;
}

export function pageInfo(total: number, page: number, limit: number) {
  const current = total ? Math.min(page, Math.ceil(total / limit)) : 1;
  return {
    total_count: total,
    total_page: Math.ceil(total / limit),
    current_page: current,
    offset: (current - 1) * limit,
  };
}

export const sqlList = (values: readonly unknown[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
