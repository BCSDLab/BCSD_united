import { getPool } from '@koin/b-bot-database';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { query } from '~/infra/postgres';
import { databaseTest as it, withDatabaseScope } from '../support/databaseScope';
import {
  cancelCoopJob,
  claimCoopJob,
  createCoopJob,
  ensureCoopJobSchema,
  findCoopJob,
  finishCoopJob,
} from '~/services/coop/jobStore';

const hasTestDb = Boolean(import.meta.env.DB_HOST) && Boolean(import.meta.env.DB_NAME?.endsWith('_test'));

const job = (token: string) => ({
  token,
  channelId: 'C1',
  threadTs: '1000.0001',
  year: 2026,
  term: '1학기',
  sourceFile: '시설물-운영시간.png',
  shopCount: 11,
  targetEnv: 'stage',
});

describe.skipIf(!hasTestDb)('생협 반영 작업 상태', () => {
  let seq = 0;
  const nextToken = () => `coop-test-${Date.now()}-${(seq += 1)}`;

  beforeAll(() => withDatabaseScope(ensureCoopJobSchema));

  afterAll(() =>
    withDatabaseScope(async () => {
      await query(getPool(), `DELETE FROM coop_update_job WHERE token LIKE 'coop-test-%'`);
    }),
  );

  it('만든 작업은 반영 대기 상태다', async () => {
    const token = nextToken();
    await createCoopJob(job(token));
    const found = await findCoopJob(token);
    expect(found?.status).toBe('PENDING');
    expect(found?.shop_count).toBe(11);
    expect(found?.target_env).toBe('stage');
  });

  it('동시에 눌러도 한 명만 반영 권한을 갖는다', async () => {
    const token = nextToken();
    await createCoopJob(job(token));
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => claimCoopJob(token, `U${index}`)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('완료된 작업에 학기 ID를 남기고 재반영을 막는다', async () => {
    const token = nextToken();
    await createCoopJob(job(token));
    await claimCoopJob(token, 'U1');
    await finishCoopJob(token, 'APPLIED', { semesterId: 17 });
    expect((await findCoopJob(token))?.semester_id).toBe(17);
    expect((await claimCoopJob(token, 'U2')).ok).toBe(false);
  });

  it('복수 학기의 ID를 함께 남긴다', async () => {
    const token = nextToken();
    await createCoopJob(job(token));
    await claimCoopJob(token, 'U1');
    await finishCoopJob(token, 'APPLIED', { semesterId: 21, semesterIds: [21, 22] });
    expect((await findCoopJob(token))?.semester_ids).toEqual([21, 22]);
  });

  it('실패한 작업은 원인을 지우고 재시도할 수 있다', async () => {
    const token = nextToken();
    await createCoopJob(job(token));
    await claimCoopJob(token, 'U1');
    await finishCoopJob(token, 'FAILED', { error: '학기 조회 실패' });
    expect((await findCoopJob(token))?.error).toBe('학기 조회 실패');
    expect((await claimCoopJob(token, 'U2')).ok).toBe(true);
    expect((await findCoopJob(token))?.error).toBeNull();
  });

  it('대기 작업만 취소할 수 있다', async () => {
    const pending = nextToken();
    await createCoopJob(job(pending));
    expect(await cancelCoopJob(pending, 'U1')).toBe(true);
    expect((await claimCoopJob(pending, 'U2')).ok).toBe(false);

    const applying = nextToken();
    await createCoopJob(job(applying));
    await claimCoopJob(applying, 'U1');
    expect(await cancelCoopJob(applying, 'U2')).toBe(false);
  });
});
