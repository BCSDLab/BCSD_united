import { getPool as getScopedPool } from '@koin/b-bot-database';
import type pg from 'pg';

export function getPool(): pg.Pool {
  return getScopedPool();
}

/**
 * 스키마 준비를 처음 한 번만 돌린다. 재사용되는 Worker에서도 스키마 준비를 중복하지 않는다.
 * 실패한 Promise를 비워 일시적인 DB 오류 뒤에 다시 시도할 수 있게 한다.
 */
export function ensureOnce(setup: () => Promise<void>): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () =>
    (ready ??= setup().catch((error) => {
      ready = undefined;
      throw error;
    }));
}

export interface ResultSet {
  rows: any;
  fields: any;
}

// 파라미터 바인딩은 $1, $2 ... (pg). values 없으면 정적 쿼리.
export async function query(pool: pg.Pool, text: string, values?: any[]): Promise<ResultSet> {
  const res = await pool.query(text, values);
  return { rows: res.rows, fields: res.fields };
}
