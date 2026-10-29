import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { submitBusTimetables } from '~/services/bus/adminApi';
import { cancelBusJob, claimBusJob, findBusJob, finishBusJob, setBusVersionSchedules } from '~/services/bus/jobStore';
import { assertPatchable } from '~/services/koin/jobLock';
import { applyBusPatchesToConversions } from '~/services/bus/patch';
import { buildStoredBusReview } from '~/services/bus/pipeline';
import {
  dropBusPatchPlan,
  loadBusPatchPlan,
  loadBusReview,
  updateBusReview,
  type StoredBusReview,
} from '~/services/bus/reviewStore';
import { labelOf } from '~/services/koin/target';
import { handleApplyButton, progressLine, type ApplyJob } from '~/services/slack/applyFlow';
import { validateConversion } from '~/services/bus/validation';
import { computeBusVersionSchedules, describeBusVersionSchedules } from '~/services/bus/versionSchedule';
import { notice } from '~/services/slack/blocks';
import { updateSlack } from '~/utils/slackFunction';
import type { BlockActionSetting } from '~/services/slack/types';
import { errorMessage } from '~/utils/errorMessage';

export const BUS_APPLY_ACTION_IDS = ['bus:apply', 'bus:cancel'] as const;
export const BUS_PATCH_ACTION_IDS = ['bus:patch_apply', 'bus:patch_cancel'] as const;

/** 버튼을 누를 때마다 새로 만든다. 어디까지 반영했는지를 이 시도만 들고 있는다. */
function busApplyJob(): ApplyJob<StoredBusReview> {
  const appliedPayloads: string[] = [];
  return {
    texts: {
      progress: '버스 시간표 반영 중',
      done: '버스 시간표 반영 완료',
      failed: '버스 시간표 반영 실패',
      expired: '버스 검토 링크 만료',
      expiredNotice: ':x: 버스 검토 링크가 만료됐습니다. 파일을 다시 올려주세요.',
      cancelled: '버스 시간표 반영 취소됨',
      cancelledTitle: '버스 시간표 반영',
    },
    retryActionId: 'bus:apply',
    claim: claimBusJob,
    cancel: cancelBusJob,
    load: loadBusReview,
    expire: (token) => finishBusJob(token, 'FAILED', '검토 링크 만료'),
    env: (stored) => stored.meta.env,
    fileName: (stored) => stored.meta.sourceFileName,
    progress: (stored, actor) =>
      `:hourglass_flowing_sand: *버스 시간표 반영 중…* ${stored.meta.routeCount}개\n${progressLine(stored.meta.env, actor)}`,
    async apply(stored, auth, token) {
      // 예약 계산은 순수 함수라 여기서 먼저 검증한다. PUT이 끝난 뒤에 실패하면
      // 이미 반영된 시간표를 FAILED로 잘못 표시하게 된다.
      const versionSchedules = computeBusVersionSchedules(stored.conversions);
      await submitBusTimetables(stored.conversions, auth, ({ target, semesterType }) => {
        appliedPayloads.push(`${target}/${semesterType}`);
      });
      await finishBusJob(token, 'APPLIED');
      // 시간표는 지금 반영됐지만, 사이트 버전 문구는 적용 전날 00:05에 바뀌어야 한다.
      await setBusVersionSchedules(token, versionSchedules);
      return (
        `:white_check_mark: *버스 시간표 반영 완료*\n` +
        `${labelOf(stored.meta.env)} · 노선 *${stored.meta.routeCount}개*\n` +
        `버전 문구 갱신 예약:\n${describeBusVersionSchedules(versionSchedules)}`
      );
    },
    async fail(token, message) {
      // 각 PUT은 대상×학기 하나를 통째로 덮어쓴다. 중간에 실패해도 앞선 PUT은 이미
      // 반영된 상태로 남으므로, 재시도가 안전하다는 것과 어디까지 갔는지를 함께 알린다.
      const detail =
        appliedPayloads.length > 0
          ? `\n:warning: 먼저 반영된 항목: ${appliedPayloads.join(', ')} · 재시도하면 같은 데이터로 다시 덮어씁니다.`
          : '';
      await finishBusJob(token, 'FAILED', `${message}${detail}`);
      return { detail };
    },
  };
}

export async function handleBusApplyAction(
  client: WebClient,
  body: BlockAction,
  action: BlockAction['actions'][number],
) {
  const mode = action.action_id === 'bus:cancel' ? 'cancel' : 'apply';
  await handleApplyButton(busApplyJob(), mode, { client, body, action });
}

export async function handleBusPatchAction(
  client: WebClient,
  body: BlockAction,
  action: BlockAction['actions'][number],
) {
  if (action.type !== 'button' || !body.channel) return;
  const { patchToken, requesterId } = JSON.parse(action.value ?? '{}') as {
    patchToken?: string;
    requesterId?: string;
  };
  if (!patchToken) return;

  const channel = body.channel.id;
  const ts = body.message?.ts;

  if (action.action_id === 'bus:patch_cancel') {
    await dropBusPatchPlan(patchToken);
    await updateSlack({
      client,
      channel,
      ts,
      text: '수정 취소됨',
      blocks: notice(':x: 수정 요청을 취소했습니다.'),
    });
    return;
  }

  const plan = await loadBusPatchPlan(patchToken);
  if (!plan) {
    await updateSlack({
      client,
      channel,
      ts,
      text: '수정 계획 만료',
      blocks: notice(':x: 수정 계획이 만료됐습니다. `!수정`을 다시 요청해주세요.'),
    });
    return;
  }
  // 먼저 지운다. 두 명이 동시에 눌러 두 번 적용되면 안 된다.
  await dropBusPatchPlan(patchToken);

  try {
    // 이미 반영됐거나 반영 중인 작업의 검토 페이지를 고치면, 실제로 보낸 값과
    // 화면이 갈라진다. Admin API는 이미 예전 값으로 나갔으니 여기서 막는다.
    assertPatchable(await findBusJob(plan.reviewToken));
    const stored = await loadBusReview(plan.reviewToken);
    if (!stored) throw new Error('검토 링크가 만료됐습니다. 파일을 다시 올려주세요.');
    const next = applyBusPatchesToConversions(stored.conversions, plan.patches).map(validateConversion);
    // HTML도 함께 다시 만든다. conversions만 바꾸면 검토 페이지가 수정 전 값을 보여준다.
    const rebuilt = buildStoredBusReview(next, {
      env: stored.meta.env,
      fileName: stored.meta.sourceFileName,
    });
    await updateBusReview(plan.reviewToken, rebuilt);

    // 버튼이 달린 원본 미리보기 메시지를 그대로 두면 이미 적용한 뒤에도 다시
    // 누를 수 있어 보인다. bus:apply/bus:cancel과 똑같이 원본을 갱신해 버튼을 없앤다.
    await updateSlack({
      client,
      channel,
      ts,
      text: '버스 시간표 수정 적용',
      blocks: [
        ...notice(
          `:white_check_mark: *수정 ${plan.patches.length}건 적용*\n검토 페이지가 갱신됐습니다. 다시 확인해주세요.`,
        ),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `요청: <@${requesterId ?? body.user.id}>` }],
        },
      ],
    });
  } catch (error) {
    const message = errorMessage(error);
    await updateSlack({
      client,
      channel,
      ts,
      text: '수정 적용 실패',
      blocks: notice(`:x: *수정 적용 실패*\n${message}\n\`!수정\`을 다시 요청해주세요.`),
    });
  }
}

/** 버스 반영·취소. 등록표는 `blockAction.ts`가 모으기만 한다. */
export const busApplyActions: BlockActionSetting[] = BUS_APPLY_ACTION_IDS.map((actionId) => ({
  actionId,
  async handler({ client, body, action }) {
    await handleBusApplyAction(client, body, action);
  },
}));

/** 버스 수정 적용·취소. 등록표는 `blockAction.ts`가 모으기만 한다. */
export const busPatchActions: BlockActionSetting[] = BUS_PATCH_ACTION_IDS.map((actionId) => ({
  actionId,
  async handler({ client, body, action }) {
    await handleBusPatchAction(client, body, action);
  },
}));
