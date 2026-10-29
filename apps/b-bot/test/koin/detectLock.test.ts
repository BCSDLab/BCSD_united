import { getPool } from '@koin/b-bot-database';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { query } from '~/infra/postgres';
import { databaseTest as it, withDatabaseScope } from '../support/databaseScope';
import { acquireDetectLock, releaseDetectLock } from '~/services/koin/detectLock';

/**
 * 실제 Postgres에 붙는 테스트. 조건부 INSERT로 하나만 통과시킨다는 게 이 모듈의
 * 전부라, 쿼리를 실제로 돌리지 않으면 검증한 게 없는 것과 같다.
 *
 * **`_test`로 끝나는 DB에서만 돈다.**
 *
 *   DB_HOST=/tmp/bbotpgs DB_PORT=55432 DB_USER=bbot DB_NAME=bbot_test pnpm test
 */
const hasTestDb = Boolean(import.meta.env.DB_HOST) && Boolean(import.meta.env.DB_NAME?.endsWith('_test'));

describe.skipIf(!hasTestDb)('감지 알림 중복 클릭 방어', () => {
  let seq = 0;
  const nextArticle = () => 900000 + (seq += 1);
  const CHANNEL = 'C_TEST';

  beforeAll(() =>
    withDatabaseScope(async () => {
      // 스키마를 미리 만들어 둔다. 동시 실행 테스트가 생성 경합을 겪지 않게.
      await acquireDetectLock('test', CHANNEL, 1, 'U0');
      await releaseDetectLock('test', CHANNEL, 1);
    }),
  );

  afterAll(() =>
    withDatabaseScope(async () => {
      await query(getPool(), `DELETE FROM detect_lock WHERE channel_id = $1`, [CHANNEL]);
    }),
  );

  it('처음 누른 사람은 통과한다', async () => {
    const result = await acquireDetectLock('lecture', CHANNEL, nextArticle(), 'U1');
    expect(result.ok).toBe(true);
  });

  it('두 번째 클릭은 막고 누가 하고 있는지 알려준다', async () => {
    const article = nextArticle();
    await acquireDetectLock('lecture', CHANNEL, article, 'U1');

    const second = await acquireDetectLock('lecture', CHANNEL, article, 'U2');
    expect(second.ok).toBe(false);
    expect(second.actor).toBe('U1');
  });

  it('동시에 열 명이 눌러도 하나만 통과한다', async () => {
    // 조회 후 삽입하면 그 사이에 끼어들 수 있다. 조건부 INSERT여야 하는 이유다.
    const article = nextArticle();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => acquireDetectLock('lecture', CHANNEL, article, `U${i}`)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('도메인이 다르면 서로 막지 않는다', async () => {
    // 같은 게시글에 강의와 버스가 함께 걸릴 이유는 없지만, 막을 이유도 없다.
    const article = nextArticle();
    expect((await acquireDetectLock('lecture', CHANNEL, article, 'U1')).ok).toBe(true);
    expect((await acquireDetectLock('bus', CHANNEL, article, 'U1')).ok).toBe(true);
  });

  it('채널이 다르면 서로 막지 않는다', async () => {
    const article = nextArticle();
    expect((await acquireDetectLock('lecture', CHANNEL, article, 'U1')).ok).toBe(true);
    expect((await acquireDetectLock('lecture', 'C_OTHER', article, 'U1')).ok).toBe(true);
    await query(getPool(), `DELETE FROM detect_lock WHERE channel_id = 'C_OTHER'`);
  });

  it('풀어주면 다시 누를 수 있다', async () => {
    // 첨부가 없거나 게시글을 못 읽은 경우. 사람이 고쳐서 다시 눌러야 한다.
    const article = nextArticle();
    await acquireDetectLock('lecture', CHANNEL, article, 'U1');
    await releaseDetectLock('lecture', CHANNEL, article);

    expect((await acquireDetectLock('lecture', CHANNEL, article, 'U2')).ok).toBe(true);
  });

  it('오래 묵은 잠금은 빼앗는다', async () => {
    // 변환 도중 프로세스가 죽으면 아무도 다시 누를 수 없게 되는데,
    // 그건 막으려던 것보다 나쁘다.
    const article = nextArticle();
    await acquireDetectLock('lecture', CHANNEL, article, 'U1');

    const pool = getPool();
    await query(
      pool,
      `UPDATE detect_lock SET created_at = now() - interval '31 minutes'
        WHERE scope = 'lecture' AND channel_id = $1 AND article_id = $2`,
      [CHANNEL, article],
    );

    const taken = await acquireDetectLock('lecture', CHANNEL, article, 'U2');
    expect(taken.ok).toBe(true);
  });
});
