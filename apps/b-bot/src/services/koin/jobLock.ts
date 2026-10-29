import { getPool, query } from '~/infra/postgres';

/**
 * 반영 작업의 상태와 락.
 *
 * 반영을 두 번 하면 손으로 지워야 한다(수정·삭제 API가 없다). 그동안 중복 방어를
 * 프로세스 메모리에 두고 있었는데, 배포할 때마다 풀려서 사실상 없는 것과 같았다.
 * DB에 두면 재시작해도 남고, 누가 언제 무엇을 반영했는지도 함께 남는다.
 *
 * 테이블은 도메인마다 따로 둔다(컬럼이 다르다). 하지만 **상태 전이 규칙은 하나다** —
 * 세 곳에 복사해두면 한 곳의 전이를 잘못 고쳤을 때 그 도메인만 조용히 두 번 반영된다.
 */
export type JobStatus = 'PENDING' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'CANCELLED';

/** 반영을 다시 시도할 수 있는 상태. 실패는 원인을 고치고 다시 누를 수 있어야 한다. */
export const CLAIMABLE: JobStatus[] = ['PENDING', 'FAILED'];

/**
 * 반영됐거나 반영 중인 작업의 검토 데이터는 고치지 않는다. Admin API에는 이미 예전 값이
 * 나갔는데 검토 화면만 바뀌면 둘이 갈라진다.
 */
export function assertPatchable(job: Pick<JobRow, 'status'> | null): void {
  if (job && !CLAIMABLE.includes(job.status)) {
    throw new Error('이미 반영됐거나 반영 중인 작업이라 수정을 적용할 수 없습니다.');
  }
}

export interface JobRow {
  token: string;
  status: JobStatus;
  actor: string | null;
}

export interface ClaimResult {
  ok: boolean;
  /** 가져가지 못한 이유. 누른 사람에게만 보여준다. */
  reason?: string;
}

/**
 * 테이블 이름은 **호출하는 코드가 문자열 리터럴로 준다.** 사용자 입력이 여기까지
 * 오지 않으므로 식별자를 문자열로 끼워 넣는다. 값은 전부 파라미터 바인딩이다.
 */
export function createJobLock<T extends JobRow>({
  table,
  ensureSchema,
}: {
  table: string;
  ensureSchema: () => Promise<void>;
}) {
  async function find(token: string): Promise<T | null> {
    await ensureSchema();
    const result = await query(getPool(), `SELECT * FROM ${table} WHERE token = $1`, [token]);
    return result.rows[0] ?? null;
  }

  return {
    find,

    /**
     * 반영 권한을 한 명만 갖게 한다.
     *
     * 조회 후 갱신하면 그 사이에 다른 사람이 끼어들 수 있다. 조건부 UPDATE 한 번으로
     * 상태를 바꾸고, 바뀐 행이 없으면 이미 누군가 가져간 것이다.
     */
    async claim(token: string, actor: string): Promise<ClaimResult> {
      await ensureSchema();
      const claimed = await query(
        getPool(),
        `UPDATE ${table}
            SET status = 'APPLYING', actor = $2, error = NULL, updated_at = now()
          WHERE token = $1 AND status = ANY($3)
          RETURNING token`,
        [token, actor, CLAIMABLE],
      );

      if (claimed.rows.length > 0) {
        return { ok: true };
      }

      const current = await find(token);
      if (!current) {
        return { ok: false, reason: '작업 기록을 찾지 못했습니다. 다시 변환해주세요.' };
      }

      return {
        ok: false,
        reason:
          {
            APPLYING: `<@${current.actor}>님이 반영을 진행 중입니다.`,
            APPLIED: `이미 <@${current.actor}>님이 반영했습니다.`,
            CANCELLED: '취소된 작업입니다. 다시 변환해주세요.',
          }[current.status as string] ?? `지금은 반영할 수 없습니다 (${current.status}).`,
      };
    },

    /**
     * `APPLYING`일 때만 종결한다. 이미 끝난 작업을 뒤늦게 온 실패 처리기가
     * 덮어쓰면 안 된다. (버스 쪽에만 있던 조건인데, 셋 다 필요한 것이라 여기로 올렸다.)
     */
    async finish(token: string, status: Extract<JobStatus, 'APPLIED' | 'FAILED'>, error?: string): Promise<void> {
      await ensureSchema();
      await query(
        getPool(),
        `UPDATE ${table}
            SET status = $2, error = $3, updated_at = now()
          WHERE token = $1 AND status = 'APPLYING'`,
        [token, status, error ?? null],
      );
    },

    /** 취소는 아직 아무도 반영하지 않았을 때만. 진행 중인 걸 가로채지 않는다. */
    async cancel(token: string, actor: string): Promise<boolean> {
      await ensureSchema();
      const result = await query(
        getPool(),
        `UPDATE ${table}
            SET status = 'CANCELLED', actor = $2, updated_at = now()
          WHERE token = $1 AND status = ANY($3)
          RETURNING token`,
        [token, actor, CLAIMABLE],
      );
      return result.rows.length > 0;
    },
  };
}
