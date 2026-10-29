import { ensureOnce, getPool, query } from '~/infra/postgres';
import { createJobLock } from '~/services/koin/jobLock';
import type { BusVersionUpdate } from './types';

/**
 * 버스 반영 작업의 상태.
 *
 * 반영을 두 번 하면 손으로 지워야 한다(수정·삭제 API가 없다). 그동안 중복 방어를
 * 프로세스 메모리(또는 파일)에 두고 있었는데, 배포할 때마다 풀려서 사실상 없는 것과
 * 같았다. DB에 두면 재시작해도 남고, 누가 언제 무엇을 반영했는지도 함께 남는다.
 */
export type { JobStatus as BusJobStatus, ClaimResult as BusClaimResult } from '~/services/koin/jobLock';
import type { JobStatus as BusJobStatus } from '~/services/koin/jobLock';

/** 반영을 다시 시도할 수 있는 상태. 실패는 원인을 고치고 다시 누를 수 있어야 한다. */

/**
 * 사이트에 노출되는 "버전" 문구는 시간표 PUT과 별개로, 적용 전날 00:05(KST)에
 * 갱신되어야 한다. Admin API PUT은 반영 즉시 나가지만 이 문구는 미리 바뀌면 안 되므로
 * 예약해두고 크론이 때가 되면 처리한다. 반영 성공 여부(status)와는 독립적인 후처리라
 * 별도 컬럼에 둔다 — coop/lecture의 클레임 상태 모델을 건드리지 않는다.
 */
export interface BusVersionSchedule {
  version_update: BusVersionUpdate;
  scheduled_at: string;
  completed_at?: string;
}

export interface BusJob {
  token: string;
  channel_id: string;
  thread_ts: string;
  source_file: string;
  route_count: number;
  semester_types: string[];
  target_env: string;
  status: BusJobStatus;
  actor: string | null;
  error: string | null;
  version_schedules: BusVersionSchedule[];
  created_at: string;
  updated_at: string;
}

export const ensureBusJobSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS bus_update_job (
       token          TEXT PRIMARY KEY,
       channel_id     TEXT NOT NULL,
       thread_ts      TEXT NOT NULL,
       source_file    TEXT NOT NULL,
       route_count    INTEGER NOT NULL,
       semester_types JSONB NOT NULL DEFAULT '[]'::jsonb,
       target_env     TEXT NOT NULL,
       status         TEXT NOT NULL DEFAULT 'PENDING',
       actor          TEXT,
       error          TEXT,
       created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  // 이미 만들어진 테이블에도 붙는다.
  await query(
    getPool(),
    `ALTER TABLE bus_update_job ADD COLUMN IF NOT EXISTS version_schedules JSONB NOT NULL DEFAULT '[]'::jsonb`,
  );
  await query(
    getPool(),
    `CREATE INDEX IF NOT EXISTS bus_update_job_thread_idx
       ON bus_update_job (channel_id, thread_ts)`,
  );
});

export async function createBusJob(job: {
  token: string;
  channelId: string;
  threadTs: string;
  sourceFile: string;
  routeCount: number;
  semesterTypes: string[];
  targetEnv: string;
}): Promise<void> {
  await ensureBusJobSchema();
  await query(
    getPool(),
    `INSERT INTO bus_update_job
       (token, channel_id, thread_ts, source_file, route_count, semester_types, target_env)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token) DO NOTHING`,
    [
      job.token,
      job.channelId,
      job.threadTs,
      job.sourceFile,
      job.routeCount,
      JSON.stringify(job.semesterTypes),
      job.targetEnv,
    ],
  );
}

const lock = createJobLock<BusJob>({ table: 'bus_update_job', ensureSchema: ensureBusJobSchema });

export const claimBusJob = lock.claim;
export const finishBusJob = lock.finish;
export const cancelBusJob = lock.cancel;
export const findBusJob = lock.find;

export async function setBusVersionSchedules(token: string, schedules: BusVersionSchedule[]): Promise<void> {
  await ensureBusJobSchema();
  await query(getPool(), `UPDATE bus_update_job SET version_schedules = $2, updated_at = now() WHERE token = $1`, [
    token,
    JSON.stringify(schedules),
  ]);
}

/** 아직 처리할 예약이 남은 반영 완료 작업. 5분 간격 크론이 이 목록을 돈다. */
export async function findBusJobsWithPendingVersionSchedules(): Promise<BusJob[]> {
  await ensureBusJobSchema();
  const result = await query(
    getPool(),
    `SELECT * FROM bus_update_job WHERE status = 'APPLIED' AND version_schedules <> '[]'::jsonb`,
  );
  return result.rows;
}
