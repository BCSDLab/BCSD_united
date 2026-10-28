import { sql, type SQL } from 'drizzle-orm';
import { executeAtomic, type Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';

export interface Mutation<T> { statements: SQL[]; value: T; outboxIds?: string[] }
export async function atomicDining<T>(db: Database, plan: () => Promise<Mutation<T>>, env?: Bindings): Promise<T> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const guard = await db.get<{ version: number }>(sql`SELECT version FROM native_dining_guard WHERE id = 'global'`);
    if (!guard) throw new ApiError(503, 'DINING_STATE_UNAVAILABLE', '식단 상태 초기값이 없습니다.');
    const mutation = await plan();
    if (!mutation.statements.length) return mutation.value;
    const token = crypto.randomUUID();
    try {
      await executeAtomic(db, [
        sql`INSERT INTO native_dining_assert (id, valid) VALUES (${token}, 1)`,
        sql`INSERT INTO native_dining_assert (id, valid) SELECT ${token}, 1 WHERE NOT EXISTS (SELECT 1 FROM native_dining_guard WHERE id = 'global' AND version = ${guard.version})`,
        sql`UPDATE native_dining_guard SET version = version + 1 WHERE id = 'global'`,
        ...mutation.statements,
        sql`DELETE FROM native_dining_assert WHERE id = ${token}`,
      ]);
      if (env && mutation.outboxIds?.length) {
        try {
          for (let offset = 0; offset < mutation.outboxIds.length; offset += 100) {
            await env.JOBS.sendBatch(mutation.outboxIds.slice(offset, offset + 100).map((id) => ({ body: { kind: 'dining.outbox', key: id, payload: {} } })));
          }
        } catch (error) {
          console.error('식단 작업은 D1에 저장되었으나 Queue 신호 전송에 실패했습니다. 복구 스케줄러가 재전송합니다.', error);
        }
      }
      return mutation.value;
    } catch (error) {
      const message = String(error) + (error instanceof Error ? String(error.cause ?? '') : '');
      if (!message.includes('native_dining_assert.id')) throw error;
    }
  }
  throw new ApiError(503, 'DINING_STATE_BUSY', '식단 상태가 변경되었습니다. 다시 시도해주세요.');
}
export async function nextId(db: Database, table: 'dining_soldout_report' | 'coop_names' | 'coop_shop' | 'coop_opens'): Promise<number> {
  const result = await db.get<{ id: number }>(sql`SELECT max(coalesce((SELECT max(id) FROM ${sql.identifier(table)}), 0), coalesce((SELECT seq FROM sqlite_sequence WHERE name = ${table}), 0)) + 1 AS id`);
  return result!.id;
}
export function outboxStatement(kind: string, payload: Record<string, unknown>, now: string, id = crypto.randomUUID()): SQL {
  return sql`INSERT INTO native_dining_outbox (id, kind, payload, due_at) VALUES (${id}, ${kind}, ${JSON.stringify(payload)}, ${now})`;
}
