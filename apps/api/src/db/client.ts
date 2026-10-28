import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { schema } from './schema';

export type Database = DrizzleD1Database<typeof schema> & { $client: D1Database };
export const createDatabase = (binding: D1Database): Database => drizzle(binding, { schema });
const dialect = new SQLiteSyncDialect();

export async function executeAtomic(db: Database, statements: SQL[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  const prepared = statements.map((statement) => {
    const query = dialect.sqlToQuery(statement);
    const params = query.params.map((value: unknown) => {
      if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new TypeError('Bind 64-bit identifiers as canonical decimal strings.');
      }
      if (typeof value === 'boolean') return Number(value);
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('D1 cannot bind a non-finite number.');
      if (value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
      throw new TypeError('D1 requires concrete scalar/binary parameters; unresolved placeholders, undefined, Date and object values are not supported.');
    });
    return db.$client.prepare(query.sql).bind(...params);
  });
  return db.$client.batch(prepared);
}

export async function allocateBigintId(db: Database, table: 'notification' | 'notification_subscribe'): Promise<string> {
  const [result] = await executeAtomic(db, [sql`
    UPDATE native_sequence SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
    WHERE id = ${table} AND CAST(value AS INTEGER) < 9223372036854775807
    RETURNING value
  `]);
  const row = result?.results?.[0] as { value?: string } | undefined;
  if (typeof row?.value !== 'string') throw new RangeError(`Missing or exhausted bigint sequence: ${table}`);
  return row.value;
}
