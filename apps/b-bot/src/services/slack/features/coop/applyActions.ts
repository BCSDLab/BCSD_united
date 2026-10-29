import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { applyCoopTimetable, applyCoopTimetables } from '~/services/coop/adminApi';
import { cancelCoopJob, claimCoopJob, finishCoopJob } from '~/services/coop/jobStore';
import { loadCoopReview, type StoredCoopReview } from '~/services/coop/reviewStore';
import { labelOf } from '~/services/koin/target';
import { handleApplyButton, progressLine, type ApplyJob } from '~/services/slack/applyFlow';
import type { BlockActionSetting } from '~/services/slack/types';

export const COOP_APPLY_ACTION_IDS = ['coop:apply', 'coop:cancel'] as const;

/** 버튼을 누를 때마다 새로 만든다. 어느 학기까지 반영했는지를 이 시도만 들고 있는다. */
function coopApplyJob(): ApplyJob<StoredCoopReview> {
  const appliedSemesterIds: number[] = [];
  return {
    texts: {
      progress: '생협 반영 중',
      done: '생협 반영 완료',
      failed: '생협 반영 실패',
      expired: '생협 검토 링크 만료',
      expiredNotice: ':x: 생협 검토 링크가 만료됐습니다. 이미지를 다시 변환해주세요.',
      cancelled: '생협 반영 취소됨',
      cancelledTitle: '생협 반영',
    },
    retryActionId: 'coop:apply',
    claim: claimCoopJob,
    cancel: cancelCoopJob,
    load: loadCoopReview,
    expire: (token) => finishCoopJob(token, 'FAILED', { error: '검토 링크 만료' }),
    validate(stored) {
      const conversions = stored.periods?.map((period) => period.conversion) ?? [stored.conversion];
      if (conversions.some(({ semester, fromDate, toDate }) => !semester || !fromDate || !toDate)) {
        throw new Error('학기 이름 또는 운영 기간이 비어 있습니다. 검토 페이지에서 확인해주세요.');
      }
    },
    env: (stored) => stored.meta.env,
    fileName: (stored) => stored.meta.sourceFileName,
    progress: (stored, actor) =>
      `:hourglass_flowing_sand: *생협 운영시간 반영 중…* ${stored.meta.shopCount}개\n${progressLine(stored.meta.env, actor)}`,
    async apply(stored, auth, token) {
      if (stored.periods) {
        await applyCoopTimetables(
          stored.periods.map((period) => ({
            semester: {
              semester: period.conversion.semester,
              from_date: period.conversion.fromDate,
              to_date: period.conversion.toDate,
            },
            timetable: period.request,
          })),
          auth,
          (semesterId) => appliedSemesterIds.push(semesterId),
        );
      } else {
        const { semester, fromDate, toDate } = stored.conversion;
        const semesterId = await applyCoopTimetable(
          {
            semester,
            from_date: fromDate,
            to_date: toDate,
          },
          stored.request,
          auth,
        );
        appliedSemesterIds.push(semesterId);
      }
      await finishCoopJob(
        token,
        'APPLIED',
        stored.periods
          ? { semesterId: appliedSemesterIds[0], semesterIds: appliedSemesterIds }
          : { semesterId: appliedSemesterIds[0] },
      );
      return (
        `:white_check_mark: *${stored.meta.year} ${stored.meta.termName} 생협 반영 완료*\n` +
        `${labelOf(stored.meta.env)} · 매장 *${stored.meta.shopCount}개* · 학기 ID ${appliedSemesterIds.join(', ')}`
      );
    },
    async fail(token, message) {
      const detail =
        appliedSemesterIds.length > 0
          ? `\n:warning: 먼저 처리된 학기 ID: ${appliedSemesterIds.join(', ')} · 재시도하면 같은 데이터로 다시 갱신합니다.`
          : '';
      await finishCoopJob(token, 'FAILED', {
        error: `${message}${detail}`,
        semesterId: appliedSemesterIds[0],
        semesterIds: appliedSemesterIds,
      });
      return { detail };
    },
  };
}

export async function handleCoopApplyAction(
  client: WebClient,
  body: BlockAction,
  action: BlockAction['actions'][number],
) {
  const mode = action.action_id === 'coop:cancel' ? 'cancel' : 'apply';
  await handleApplyButton(coopApplyJob(), mode, { client, body, action });
}

/** 생협 반영·취소. 등록표는 `blockAction.ts`가 모으기만 한다. */
export const coopApplyActions: BlockActionSetting[] = COOP_APPLY_ACTION_IDS.map((actionId) => ({
  actionId,
  async handler({ client, body, action }) {
    await handleCoopApplyAction(client, body, action);
  },
}));
