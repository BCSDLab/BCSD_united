import { sql, type SQL } from 'drizzle-orm';
import { executeAtomic, type Database } from '@api/db/client';
import { ApiError } from '@api/errors';

export async function first<T extends Record<string, unknown>>(db: Database, query: SQL): Promise<T | undefined> {
  return (await db.all<T>(query))[0];
}

export async function revision(db: Database, userId: number): Promise<number> {
  await db.run(
    sql`INSERT INTO native_commerce_revision(user_id,revision) VALUES(${userId},0) ON CONFLICT(user_id) DO NOTHING`,
  );
  return (await first<{ revision: number }>(
    db,
    sql`SELECT revision FROM native_commerce_revision WHERE user_id=${userId}`,
  ))!.revision;
}

export async function guardedBatch(db: Database, condition: SQL, statements: SQL[]): Promise<D1Result[]> {
  const token = crypto.randomUUID();
  try {
    return await executeAtomic(db, [
      sql`INSERT INTO native_commerce_guard(id,valid) VALUES(${token},CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
      ...statements,
      sql`DELETE FROM native_commerce_guard WHERE id=${token}`,
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /CHECK constraint failed.*(?:valid|native_commerce_guard)/i.test(`${error.message} ${String(error.cause ?? '')}`)
    ) {
      throw new ApiError(409, 'CONCURRENT_MODIFICATION', '요청 처리 중 정보가 변경되었습니다. 다시 시도해주세요.');
    }
    throw error;
  }
}

export async function mutateCart(
  db: Database,
  userId: number,
  expectedRevision: number,
  statements: SQL[],
): Promise<void> {
  await guardedBatch(
    db,
    sql`EXISTS(SELECT 1 FROM native_commerce_revision WHERE user_id=${userId} AND revision=${expectedRevision})`,
    [...statements, sql`UPDATE native_commerce_revision SET revision=revision+1 WHERE user_id=${userId}`],
  );
}

export function outbox(kind: string, key: string, payload: Record<string, unknown>, now = Date.now()): SQL {
  return sql`INSERT INTO native_commerce_outbox(id,kind,aggregate_id,payload,created_at,available_at,attempts)
    VALUES(${`${kind}:${key}`},${kind},${key},${JSON.stringify(payload)},${new Date(now).toISOString()},${now},0) ON CONFLICT(id) DO NOTHING`;
}
