import { ensureOnce, getPool, query } from '~/infra/postgres';
import { createJobLock } from '~/services/koin/jobLock';

export type { JobStatus as CoopJobStatus, ClaimResult as CoopClaimResult } from '~/services/koin/jobLock';
import type { JobStatus as CoopJobStatus } from '~/services/koin/jobLock';

export interface CoopJob {
  token: string;
  channel_id: string;
  thread_ts: string;
  year: number;
  term: string;
  source_file: string;
  shop_count: number;
  target_env: string;
  semester_id: number | null;
  semester_ids: number[];
  status: CoopJobStatus;
  actor: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const ensureCoopJobSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS coop_update_job (
       token       TEXT PRIMARY KEY,
       channel_id  TEXT NOT NULL,
       thread_ts   TEXT NOT NULL,
       year        INTEGER NOT NULL,
       term        TEXT NOT NULL,
       source_file TEXT NOT NULL,
       shop_count  INTEGER NOT NULL,
       target_env  TEXT NOT NULL,
       semester_id INTEGER,
       semester_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
       status      TEXT NOT NULL DEFAULT 'PENDING',
       actor       TEXT,
       error       TEXT,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await query(
    getPool(),
    `ALTER TABLE coop_update_job
       ADD COLUMN IF NOT EXISTS semester_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
  );
  await query(
    getPool(),
    `CREATE INDEX IF NOT EXISTS coop_update_job_thread_idx
       ON coop_update_job (channel_id, thread_ts)`,
  );
});

export async function createCoopJob(job: {
  token: string;
  channelId: string;
  threadTs: string;
  year: number;
  term: string;
  sourceFile: string;
  shopCount: number;
  targetEnv: string;
}): Promise<void> {
  await ensureCoopJobSchema();
  await query(
    getPool(),
    `INSERT INTO coop_update_job
       (token, channel_id, thread_ts, year, term, source_file, shop_count, target_env)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (token) DO NOTHING`,
    [job.token, job.channelId, job.threadTs, job.year, job.term, job.sourceFile, job.shopCount, job.targetEnv],
  );
}

const lock = createJobLock<CoopJob>({ table: 'coop_update_job', ensureSchema: ensureCoopJobSchema });

export const claimCoopJob = lock.claim;
export const cancelCoopJob = lock.cancel;
export const findCoopJob = lock.find;

/**
 * 생협은 종결하면서 학기 id도 함께 남겨야 해서 공통 finish를 쓰지 않는다.
 * APPLYING일 때만 종결하는 조건은 공통과 같게 맞춘다 — 이미 끝난 작업을
 * 뒤늦게 온 실패 처리기가 덮어쓰면 안 된다.
 */
export async function finishCoopJob(
  token: string,
  status: Extract<CoopJobStatus, 'APPLIED' | 'FAILED'>,
  options: { error?: string; semesterId?: number; semesterIds?: number[] } = {},
): Promise<void> {
  await ensureCoopJobSchema();
  await query(
    getPool(),
    `UPDATE coop_update_job
        SET status = $2,
            error = $3,
            semester_id = COALESCE($4, semester_id),
            semester_ids = COALESCE($5::jsonb, semester_ids),
            updated_at = now()
      WHERE token = $1 AND status = 'APPLYING'`,
    [
      token,
      status,
      options.error ?? null,
      options.semesterId ?? null,
      options.semesterIds ? JSON.stringify(options.semesterIds) : null,
    ],
  );
}
