import {
  AdminApiError,
  buildAdminRequest,
  ensureSemester,
  submitLectures,
  toAdminTerm,
} from '~/services/lecture/adminApi';
import { cancelJob, claimJob, findJob, finishJob } from '~/services/lecture/jobStore';
import { assertPatchable } from '~/services/koin/jobLock';
import { labelOf } from '~/services/koin/target';
import { handleApplyButton, type ApplyJob } from '~/services/slack/applyFlow';
import { applyPatches, resolveAmbiguities } from '~/services/lecture/patch';
import { buildStoredReview } from '~/services/lecture/pipeline';
import { buildPatchBlocks } from '~/services/slack/features/lecture/blocks';
import {
  dropPatchPlan,
  loadPatchPlan,
  loadReview,
  savePatchPlan,
  updateReview,
  type StoredReview,
} from '~/services/lecture/reviewStore';
import type { BlockActionSetting } from '~/services/slack/types';
import { updateSlack } from '~/utils/slackFunction';
import { errorMessage } from '~/utils/errorMessage';

/** 검토 결과에 대한 수정 적용·반영·취소. */
export const lectureActions: BlockActionSetting[] = [
  // 교시/시각 선택. LLM에 다시 묻지 않고 이미 계산해둔 두 해석 중 하나를 고른다.
  ...(['period', 'clock'] as const).map((mode) => ({
    actionId: mode === 'period' ? 'lecture:time_period' : 'lecture:time_clock',
    async handler({ client, body, action }: Parameters<BlockActionSetting['handler']>[0]) {
      if (action.type !== 'button' || !body.channel) return;

      const { patchToken, requesterId } = JSON.parse(action.value ?? '{}') as {
        patchToken?: string;
        requesterId?: string;
      };
      const channel = body.channel.id;
      const ts = body.message?.ts;
      if (!patchToken) return;

      const plan = await loadPatchPlan(patchToken);
      if (!plan) {
        await updateSlack({
          client,
          channel,
          ts,
          text: '만료됨',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':x: 이미 처리했거나 만료된 수정 요청입니다.' } }],
        });
        return;
      }
      await dropPatchPlan(patchToken);

      const resolved = {
        patches: [...plan.patches, ...resolveAmbiguities(plan.ambiguities, mode)],
        ambiguities: [],
        problems: plan.problems,
      };
      const nextToken = await savePatchPlan(plan.reviewToken, resolved);

      await updateSlack({
        client,
        channel,
        ts,
        text: `수정 ${resolved.patches.length}건 확인`,
        blocks: buildPatchBlocks(resolved, nextToken, requesterId ?? body.user.id),
      });
    },
  })),
  {
    actionId: 'lecture:patch_apply',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel) return;

      const { patchToken } = JSON.parse(action.value ?? '{}') as { patchToken?: string };
      const channel = body.channel.id;
      const ts = body.message?.ts;
      const actor = body.user.id;
      if (!patchToken) return;

      const say = (text: string, blocks: Parameters<typeof updateSlack>[0]['blocks']) =>
        updateSlack({ client, channel, ts, text, blocks });

      const plan = await loadPatchPlan(patchToken);
      if (!plan) {
        await say('만료됨', [
          { type: 'section', text: { type: 'mrkdwn', text: ':x: 이미 처리했거나 만료된 수정 요청입니다.' } },
        ]);
        return;
      }
      // 먼저 지운다. 두 명이 동시에 눌러 두 번 적용되면 안 된다.
      await dropPatchPlan(patchToken);

      try {
        assertPatchable(await findJob(plan.reviewToken));
        const stored = await loadReview(plan.reviewToken);
        if (!stored) {
          await say('검토 만료', [
            { type: 'section', text: { type: 'mrkdwn', text: ':x: 검토 링크가 만료됐습니다. 다시 변환해주세요.' } },
          ]);
          return;
        }

        const patched = applyPatches(stored.lectures, plan.patches);
        await updateReview(
          plan.reviewToken,
          buildStoredReview(patched, stored.timeFormat, {
            env: stored.meta.env,
            year: stored.meta.year,
            termName: stored.meta.termName,
            fileName: stored.meta.sourceFileName,
          }),
        );

        await say(`수정 ${plan.patches.length}건 적용`, [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *수정 ${plan.patches.length}건 적용*\n검토 페이지를 새로고침하면 반영돼 있습니다.`,
            },
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `작업자: <@${actor}>` }] },
        ]);
      } catch (error) {
        await say('수정 실패', [
          { type: 'section', text: { type: 'mrkdwn', text: `:x: *수정 적용 실패*\n${errorMessage(error)}` } },
        ]);
      }
    },
  },
  {
    actionId: 'lecture:patch_cancel',
    async handler({ client, body, action }) {
      if (action.type !== 'button' || !body.channel) return;

      const { patchToken } = JSON.parse(action.value ?? '{}') as { patchToken?: string };
      if (patchToken) {
        await dropPatchPlan(patchToken);
      }

      await updateSlack({
        client,
        channel: body.channel.id,
        ts: body.message?.ts,
        text: '수정 취소됨',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:no_entry_sign: *수정을 취소했습니다.*\n<@${body.user.id}>` },
          },
        ],
      });
    },
  },
  {
    actionId: 'lecture:apply',
    async handler(press) {
      await handleApplyButton(lectureApplyJob(), 'apply', press);
    },
  },
  {
    actionId: 'lecture:cancel',
    async handler(press) {
      await handleApplyButton(lectureApplyJob(), 'cancel', press);
    },
  },
];

/** 버튼을 누를 때마다 새로 만든다. 실패 안내에 반영하려던 규모와 단계를 써야 해서 들고 있는다. */
function lectureApplyJob(): ApplyJob<StoredReview> {
  let lectureCount = 0;
  let submitting = false;
  return {
    texts: {
      progress: '반영 중',
      done: '반영 완료',
      failed: '반영 실패',
      expired: '검토 링크 만료',
      expiredNotice: ':x: 검토 링크가 만료됐습니다. 다시 변환해주세요.',
      cancelled: '취소됨',
      cancelledTitle: '반영',
    },
    retryActionId: 'lecture:apply',
    claim: claimJob,
    cancel: cancelJob,
    load: loadReview,
    expire: (token) => finishJob(token, 'FAILED', '검토 링크 만료'),
    env: (stored) => stored.meta.env,
    fileName: (stored) => stored.meta.sourceFileName,
    progress: (stored, actor) =>
      `:hourglass_flowing_sand: *반영 중…* ${stored.meta.lectureCount}건\n작업자: <@${actor}>`,
    async apply(stored, auth, token) {
      lectureCount = stored.meta.lectureCount;
      // 저장된 강의 목록에서 요청을 다시 만든다. 검토 화면이 보여준 것과
      // 실제로 보내는 값이 갈라지지 않게 하려는 것이다.
      const { request } = buildAdminRequest(stored.lectures, {
        year: stored.meta.year,
        term: toAdminTerm(stored.meta.termName),
      });
      // 학기가 없으면 강의 생성이 404로 막힌다. 이미 있으면 서버가 무시한다.
      await ensureSemester(request, auth);
      submitting = true;
      await submitLectures(request, auth);
      await finishJob(token, 'APPLIED');
      return (
        `:white_check_mark: *${stored.meta.year} ${stored.meta.termName} 반영 완료*\n` +
        `${labelOf(stored.meta.env)} · 강의 *${stored.meta.lectureCount}건*`
      );
    },
    async fail(token, message, error) {
      await finishJob(token, 'FAILED', message);
      // 강의 생성 도중에 났으면 서버가 어디까지 넣었는지 우리는 모른다. 시한 초과나
      // 연결 끊김은 AdminApiError가 아니라 일반 Error로 오므로 단계로도 판단한다.
      // 지울 API가 없으니, 다시 누르기 전에 그 사실을 먼저 말한다.
      const mayBePartial = submitting || (error instanceof AdminApiError && error.stage === 'lectures');
      if (!mayBePartial) return {};
      return {
        warning:
          ':warning: 강의 생성 중에 멈췄습니다. *일부가 이미 들어갔을 수 있습니다.*\n' +
          '지우는 API가 없으니, 다시 시도하기 전에 반영 상태를 확인해주세요.',
        confirm: {
          title: '다시 반영할까요?',
          text:
            `*${lectureCount}건*을 다시 보냅니다.\n` +
            '앞선 시도에서 일부가 이미 들어갔다면 중복될 수 있고, 되돌릴 수 없습니다.',
          confirm: '그래도 반영',
          deny: '취소',
        },
      };
    },
  };
}
