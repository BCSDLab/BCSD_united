import { applyCoopPatches } from '~/services/coop/patch';
import { findCoopJob } from '~/services/coop/jobStore';
import { assertPatchable } from '~/services/koin/jobLock';
import { buildCoopApplyButtons } from '~/services/slack/features/coop/blocks';
import { renderRegularCoopReview, renderVacationCoopReview } from '~/services/coop/reviewHtml';
import { dropCoopPatchPlan, loadCoopPatchPlan, loadCoopReview, updateCoopReview } from '~/services/coop/reviewStore';
import { notice } from '~/services/slack/blocks';
import type { BlockActionSetting } from '~/services/slack/types';
import { updateSlack } from '~/utils/slackFunction';
import { errorMessage } from '~/utils/errorMessage';

function vacationSeason(termName: string): '하계' | '동계' {
  return termName.startsWith('하계') ? '하계' : '동계';
}

/** 생협 검토 중 올라온 수정 요청의 적용·취소. */
export const coopPatchActions: BlockActionSetting[] = [
  {
    actionId: 'coop:patch_apply',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel) return;
      const { patchToken } = JSON.parse(action.value ?? '{}') as { patchToken?: string };
      const channel = body.channel.id;
      const ts = body.message?.ts;
      const actor = body.user.id;
      if (!patchToken) return;

      const plan = await loadCoopPatchPlan(patchToken);
      if (!plan) {
        await updateSlack({
          client,
          channel,
          ts,
          text: '만료됨',
          blocks: notice(':x: 이미 처리했거나 만료된 생협 수정 요청입니다.'),
        });
        return;
      }
      // 두 사람이 동시에 같은 버튼을 눌러도 한 번만 적용한다.
      await dropCoopPatchPlan(patchToken);

      try {
        assertPatchable(await findCoopJob(plan.reviewToken));
        const stored = await loadCoopReview(plan.reviewToken);
        if (!stored?.conversion) {
          await updateSlack({
            client,
            channel,
            ts,
            text: '검토 만료',
            blocks: notice(':x: 생협 검토 링크가 만료됐거나 수정 가능한 변환 데이터가 없습니다. 다시 변환해주세요.'),
          });
          return;
        }
        const selected =
          plan.periodIndex === undefined ? stored.conversion : stored.periods?.[plan.periodIndex]?.conversion;
        if (!selected) throw new Error('수정할 학기 데이터를 찾지 못했습니다.');
        const conversion = applyCoopPatches(selected, plan.patches);
        const periods = stored.periods?.map((period, index) =>
          index === plan.periodIndex ? { ...period, conversion, request: conversion.request } : period,
        );
        const blockingCount = periods
          ? periods.reduce(
              (count, period) =>
                count + period.conversion.issues.filter((issue) => issue.severity === 'blocking').length,
              0,
            )
          : conversion.issues.filter((issue) => issue.severity === 'blocking').length;
        const primary = periods?.[0]?.conversion ?? conversion;
        const html = periods
          ? renderVacationCoopReview({
              year: stored.meta.year,
              season: vacationSeason(stored.meta.termName),
              vacationStartDate: periods[1].conversion.fromDate,
              seasonal: periods[0].conversion,
              vacation: periods[1].conversion,
            })
          : renderRegularCoopReview(conversion);
        await updateCoopReview(plan.reviewToken, {
          ...stored,
          conversion: primary,
          request: primary.request,
          periods,
          html,
          meta: { ...stored.meta, blockingCount },
        });
        await updateSlack({
          client,
          channel,
          ts,
          text: `생협 수정 ${plan.patches.length}건 적용`,
          blocks: [
            ...notice(
              `:white_check_mark: *생협 수정 ${plan.patches.length}건 적용*\n검토 페이지를 새로고침하면 반영돼 있습니다.`,
            ),
            ...(blockingCount > 0 ? notice(`:warning: 확인이 필요한 항목이 *${blockingCount}건* 남아 있습니다.`) : []),
            {
              type: 'actions' as const,
              elements: buildCoopApplyButtons(plan.reviewToken, stored.meta.env, stored.meta.shopCount),
            },
            { type: 'context', elements: [{ type: 'mrkdwn', text: `작업자: <@${actor}>` }] },
          ],
        });
      } catch (error) {
        await updateSlack({
          client,
          channel,
          ts,
          text: '생협 수정 실패',
          blocks: notice(`:x: *생협 수정 적용 실패*\n${errorMessage(error)}`),
        });
      }
    },
  },
  {
    actionId: 'coop:patch_cancel',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel) return;
      const { patchToken } = JSON.parse(action.value ?? '{}') as { patchToken?: string };
      if (patchToken) await dropCoopPatchPlan(patchToken);
      await updateSlack({
        client,
        channel: body.channel.id,
        ts: body.message?.ts,
        text: '생협 수정 취소됨',
        blocks: notice(`:no_entry_sign: *생협 수정을 취소했습니다.*\n<@${body.user.id}>`),
      });
    },
  },
];
