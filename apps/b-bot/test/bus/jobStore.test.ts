import { getPool } from '@koin/b-bot-database';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { query } from '~/infra/postgres';
import { databaseTest as it, withDatabaseScope } from '../support/databaseScope';
import {
  cancelBusJob,
  claimBusJob,
  createBusJob,
  ensureBusJobSchema,
  findBusJobsWithPendingVersionSchedules,
  finishBusJob,
  findBusJob,
  setBusVersionSchedules,
} from '~/services/bus/jobStore';

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
  sourceFile: '버스시간표.xlsx',
  routeCount: 42,
  semesterTypes: ['REGULAR'],
  targetEnv: 'stage',
});

describe.skipIf(!hasTestDb)('버스 반영 작업 상태', () => {
  let seq = 0;
  const nextToken = () => `test-${Date.now()}-${(seq += 1)}`;

  beforeAll(() => withDatabaseScope(ensureBusJobSchema));

  afterAll(() =>
    withDatabaseScope(async () => {
      await query(getPool(), `DELETE FROM bus_update_job WHERE token LIKE 'test-%'`);
    }),
  );

  it('스키마 생성은 여러 번 불러도 된다', async () => {
    await ensureBusJobSchema();
    await ensureBusJobSchema();
  });

  it('만든 작업은 반영 대기 상태다', async () => {
    const token = nextToken();
    await createBusJob(job(token));

    const found = await findBusJob(token);
    expect(found?.status).toBe('PENDING');
    expect(found?.route_count).toBe(42);
  });

  it('같은 토큰을 두 번 만들어도 덮어쓰지 않는다', async () => {
    const token = nextToken();
    await createBusJob(job(token));
    await claimBusJob(token, 'U1');
    // 재변환 등으로 다시 불려도 진행 중인 상태를 되돌리면 안 된다.
    await createBusJob(job(token));

    expect((await findBusJob(token))?.status).toBe('APPLYING');
  });

  it('먼저 누른 사람만 반영 권한을 갖는다', async () => {
    const token = nextToken();
    await createBusJob(job(token));

    const [first, second] = await Promise.all([claimBusJob(token, 'U1'), claimBusJob(token, 'U2')]);

    // 되돌릴 API가 없어 두 번 반영되면 손으로 지워야 한다.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect((await findBusJob(token))?.status).toBe('APPLYING');
  });

  it('동시에 열 명이 눌러도 하나만 통과한다', async () => {
    const token = nextToken();
    await createBusJob(job(token));

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimBusJob(token, `U${i}`)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('이미 반영된 작업은 다시 가져갈 수 없다', async () => {
    const token = nextToken();
    await createBusJob(job(token));
    await claimBusJob(token, 'U1');
    await finishBusJob(token, 'APPLIED');

    const again = await claimBusJob(token, 'U2');
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/이미/);
  });

  it('실패한 작업은 원인을 고쳐 다시 시도할 수 있다', async () => {
    const token = nextToken();
    await createBusJob(job(token));
    await claimBusJob(token, 'U1');
    await finishBusJob(token, 'FAILED', '검토 링크 만료');

    expect((await findBusJob(token))?.error).toBe('검토 링크 만료');

    const retry = await claimBusJob(token, 'U2');
    expect(retry.ok).toBe(true);
    // 재시도할 땐 지난 실패 사유를 지운다.
    expect((await findBusJob(token))?.error).toBeNull();
  });

  it('진행 중인 작업은 취소되지 않는다', async () => {
    const token = nextToken();
    await createBusJob(job(token));
    await claimBusJob(token, 'U1');

    expect(await cancelBusJob(token, 'U2')).toBe(false);
    expect((await findBusJob(token))?.status).toBe('APPLYING');
  });

  it('아직 아무도 누르지 않은 작업은 취소된다', async () => {
    const token = nextToken();
    await createBusJob(job(token));

    expect(await cancelBusJob(token, 'U1')).toBe(true);
    // 취소한 뒤에는 반영도 막힌다.
    expect((await claimBusJob(token, 'U2')).ok).toBe(false);
  });

  it('없는 작업을 가져가려 하면 이유를 알려준다', async () => {
    const result = await claimBusJob('test-없는토큰', 'U1');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/찾지 못/);
  });

  it('반영 완료 후 예약을 걸면 대기 목록에 나타나고, 비우면 사라진다', async () => {
    const token = nextToken();
    await createBusJob(job(token));
    await claimBusJob(token, 'U1');
    await finishBusJob(token, 'APPLIED');

    const schedule = {
      version_update: {
        type: 'shuttle_bus_timetable' as const,
        title: '정규학기' as const,
        content: '2026-03-02~2026-06-19',
      },
      scheduled_at: '2026-03-01T15:05:00.000Z',
    };
    await setBusVersionSchedules(token, [schedule]);

    const pending = await findBusJobsWithPendingVersionSchedules();
    expect(pending.map((j) => j.token)).toContain(token);
    expect(pending.find((j) => j.token === token)?.version_schedules).toEqual([schedule]);

    await setBusVersionSchedules(token, []);
    const afterClear = await findBusJobsWithPendingVersionSchedules();
    expect(afterClear.map((j) => j.token)).not.toContain(token);
  });
});
