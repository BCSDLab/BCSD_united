import { getPool } from '@koin/b-bot-database';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { query } from '~/infra/postgres';
import { databaseTest as it, withDatabaseScope } from '../support/databaseScope';
import { cancelJob, claimJob, createJob, ensureSchema, finishJob, findJob } from '~/services/lecture/jobStore';

/**
 * 실제 Postgres에 붙는 테스트. 조건부 UPDATE로 권한을 하나만 준다는 게 이 모듈의
 * 전부라, 쿼리를 실제로 돌리지 않으면 검증한 게 없는 것과 같다.
 *
 * **`_test`로 끝나는 DB에서만 돈다.** .env의 DB_*는 운영 봇 Postgres를 가리키므로,
 * 그냥 두면 `pnpm test`가 운영 DB에 쓰기를 한다.
 *
 *   DB_HOST=/tmp/bbotpgs DB_PORT=55432 DB_USER=bbot DB_NAME=bbot_test pnpm test
 */
const hasTestDb = Boolean(import.meta.env.DB_HOST) && Boolean(import.meta.env.DB_NAME?.endsWith('_test'));

const job = (token: string) => ({
  token,
  channelId: 'C1',
  threadTs: '1000.0001',
  year: 2026,
  term: '여름학기',
  sourceFile: '편람.xlsx',
  lectureCount: 21,
  targetEnv: 'stage',
});

describe.skipIf(!hasTestDb)('강의 반영 작업 상태', () => {
  let seq = 0;
  const nextToken = () => `test-${Date.now()}-${(seq += 1)}`;

  beforeAll(() => withDatabaseScope(ensureSchema));

  afterAll(() =>
    withDatabaseScope(async () => {
      await query(getPool(), `DELETE FROM lecture_update_job WHERE token LIKE 'test-%'`);
    }),
  );

  it('스키마 생성은 여러 번 불러도 된다', async () => {
    await ensureSchema();
    await ensureSchema();
  });

  it('만든 작업은 반영 대기 상태다', async () => {
    const token = nextToken();
    await createJob(job(token));

    const found = await findJob(token);
    expect(found?.status).toBe('PENDING');
    expect(found?.lecture_count).toBe(21);
  });

  it('같은 토큰을 두 번 만들어도 덮어쓰지 않는다', async () => {
    const token = nextToken();
    await createJob(job(token));
    await claimJob(token, 'U1');
    // 재변환 등으로 다시 불려도 진행 중인 상태를 되돌리면 안 된다.
    await createJob(job(token));

    expect((await findJob(token))?.status).toBe('APPLYING');
  });

  it('먼저 누른 사람만 반영 권한을 갖는다', async () => {
    const token = nextToken();
    await createJob(job(token));

    const [first, second] = await Promise.all([claimJob(token, 'U1'), claimJob(token, 'U2')]);

    // 되돌릴 API가 없어 두 번 반영되면 손으로 지워야 한다.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect((await findJob(token))?.status).toBe('APPLYING');
  });

  it('동시에 열 명이 눌러도 하나만 통과한다', async () => {
    const token = nextToken();
    await createJob(job(token));

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimJob(token, `U${i}`)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('이미 반영된 작업은 다시 가져갈 수 없다', async () => {
    const token = nextToken();
    await createJob(job(token));
    await claimJob(token, 'U1');
    await finishJob(token, 'APPLIED');

    const again = await claimJob(token, 'U2');
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/이미/);
  });

  it('실패한 작업은 원인을 고쳐 다시 시도할 수 있다', async () => {
    const token = nextToken();
    await createJob(job(token));
    await claimJob(token, 'U1');
    await finishJob(token, 'FAILED', '학기 없음');

    expect((await findJob(token))?.error).toBe('학기 없음');

    const retry = await claimJob(token, 'U2');
    expect(retry.ok).toBe(true);
    // 재시도할 땐 지난 실패 사유를 지운다.
    expect((await findJob(token))?.error).toBeNull();
  });

  it('진행 중인 작업은 취소되지 않는다', async () => {
    const token = nextToken();
    await createJob(job(token));
    await claimJob(token, 'U1');

    expect(await cancelJob(token, 'U2')).toBe(false);
    expect((await findJob(token))?.status).toBe('APPLYING');
  });

  it('아직 아무도 누르지 않은 작업은 취소된다', async () => {
    const token = nextToken();
    await createJob(job(token));

    expect(await cancelJob(token, 'U1')).toBe(true);
    // 취소한 뒤에는 반영도 막힌다.
    expect((await claimJob(token, 'U2')).ok).toBe(false);
  });

  it('없는 작업을 가져가려 하면 이유를 알려준다', async () => {
    const result = await claimJob('test-없는토큰', 'U1');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/찾지 못/);
  });
});
