import { ensureOnce, getPool, query } from '~/infra/postgres';

/**
 * 감지 알림의 `예`를 한 번만 통과시킨다.
 *
 * 지금까지 이 버튼을 막는 건 `response_url`로 원본 메시지를 갈아끼우는 것뿐이었다.
 * 그건 락이 아니라 경쟁이다. 두 사람이 거의 동시에 누르거나 한 사람이 두 번 누르면
 * 둘 다 통과하고, 변환이 두 번 돌아 **검토 링크와 [반영] 버튼이 둘씩 생긴다.**
 *
 * 반영 락(`jobLock`)은 토큰 단위라 여기서 갈라진 두 건 사이에서는 아무 일도 하지 않는다.
 * 그대로 두면 같은 학기가 두 번 들어가고, 지울 API가 없다.
 *
 * 조건부 INSERT 한 번으로 잡는다. 조회 후 삽입하면 그 사이에 끼어들 수 있다.
 */
const STALE_MINUTES = 30;

const ensureSchema = ensureOnce(async () => {
  await query(
    getPool(),
    `CREATE TABLE IF NOT EXISTS detect_lock (
       scope      TEXT NOT NULL,
       channel_id TEXT NOT NULL,
       article_id BIGINT NOT NULL,
       actor      TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (scope, channel_id, article_id)
     )`,
  );
});

export interface DetectLockResult {
  ok: boolean;
  /** 이미 누군가 진행 중일 때, 누구인지. 누른 사람에게만 보여준다. */
  actor?: string;
}

/**
 * `scope`는 도메인 이름(`lecture` · `bus` · `coop`). 같은 게시글이라도 도메인이 다르면
 * 서로 막지 않는다.
 *
 * 30분이 지난 잠금은 빼앗는다. 변환 도중 프로세스가 죽으면 아무도 다시 누를 수 없게
 * 되는데, 그건 막으려던 것보다 나쁘다.
 */
export async function acquireDetectLock(
  scope: string,
  channel: string,
  articleId: number,
  actor: string,
): Promise<DetectLockResult> {
  await ensureSchema();

  const claimed = await query(
    getPool(),
    `INSERT INTO detect_lock (scope, channel_id, article_id, actor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, channel_id, article_id) DO UPDATE
        SET actor = EXCLUDED.actor, created_at = now()
      WHERE detect_lock.created_at < now() - ($5 || ' minutes')::interval
     RETURNING actor`,
    [scope, channel, articleId, actor, String(STALE_MINUTES)],
  );

  if (claimed.rows.length > 0) {
    return { ok: true };
  }

  const current = await query(
    getPool(),
    `SELECT actor FROM detect_lock
      WHERE scope = $1 AND channel_id = $2 AND article_id = $3`,
    [scope, channel, articleId],
  );
  return { ok: false, actor: current.rows[0]?.actor };
}

/**
 * 처리가 끝나면(성공·실패·취소 무관) 항상 푼다.
 *
 * 원본 "확인" 버튼은 락을 잡는 즉시 다른 문구로 갈아끼우므로, 그 이후로는 결과와
 * 무관하게 다시 눌릴 방법이 없다. 동시 클릭 방지는 `acquireDetectLock`의 원자적
 * INSERT가 담당하니, 처리 끝난 락을 계속 들고 있을 이유가 없다.
 */
export async function releaseDetectLock(scope: string, channel: string, articleId: number): Promise<void> {
  await query(getPool(), `DELETE FROM detect_lock WHERE scope = $1 AND channel_id = $2 AND article_id = $3`, [
    scope,
    channel,
    articleId,
  ]);
}
