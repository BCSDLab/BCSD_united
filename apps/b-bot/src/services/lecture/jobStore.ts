import { ensureOnce, getPool, query } from '~/infra/postgres';
import { createJobLock } from '~/services/koin/jobLock';

export type { ClaimResult, JobStatus } from '~/services/koin/jobLock';
import type { JobStatus } from '~/services/koin/jobLock';

export interface LectureJob {
  token: string;
  channel_id: string;
  thread_ts: string;
  year: number;
  term: string;
  source_file: string;
  lecture_count: number;
  target_env: string | null;
  status: JobStatus;
  actor: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const ensureSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS lecture_update_job (
       token         TEXT PRIMARY KEY,
       channel_id    TEXT NOT NULL,
       thread_ts     TEXT NOT NULL,
       year          INTEGER NOT NULL,
       term          TEXT NOT NULL,
       source_file   TEXT NOT NULL,
       lecture_count INTEGER NOT NULL,
       status        TEXT NOT NULL DEFAULT 'PENDING',
       actor         TEXT,
       error         TEXT,
       created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  // 이미 만들어진 테이블에도 붙는다. 어디에 반영했는지는 나중에 꼭 필요해진다.
  await query(getPool(), `ALTER TABLE lecture_update_job ADD COLUMN IF NOT EXISTS target_env TEXT`);
  await query(
    getPool(),
    `CREATE INDEX IF NOT EXISTS lecture_update_job_thread_idx
       ON lecture_update_job (channel_id, thread_ts)`,
  );
});

export async function createJob(job: {
  token: string;
  channelId: string;
  threadTs: string;
  year: number;
  term: string;
  sourceFile: string;
  lectureCount: number;
  targetEnv: string;
}): Promise<void> {
  await ensureSchema();
  await query(
    getPool(),
    `INSERT INTO lecture_update_job
       (token, channel_id, thread_ts, year, term, source_file, lecture_count, target_env)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (token) DO NOTHING`,
    [job.token, job.channelId, job.threadTs, job.year, job.term, job.sourceFile, job.lectureCount, job.targetEnv],
  );
}

const lock = createJobLock<LectureJob>({ table: 'lecture_update_job', ensureSchema });

export const claimJob = lock.claim;
export const finishJob = lock.finish;
export const cancelJob = lock.cancel;
export const findJob = lock.find;
