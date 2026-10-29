import type { KnownBlock } from '@slack/web-api';
import type { CoopPatch, CoopPatchPlan } from '~/services/coop/patch';
import { labelOf, isProduction, type KoinEnv } from '~/services/koin/target';
import type {
  RegularCoopOutcome,
  RegularCoopTarget,
  VacationCoopOutcome,
  VacationCoopTarget,
} from '~/services/coop/pipeline';

export function buildVacationCoopResultBlocks(
  outcome: VacationCoopOutcome,
  target: VacationCoopTarget,
  requesterId: string,
): KnownBlock[] {
  const lines = [
    `*${target.year} ${target.season} 생협 운영시간* 변환 완료`,
    `대상: ${labelOf(target.env)}`,
    `학기 *2개* · 학기별 매장 *${outcome.shopCount}개*`,
  ];
  if (outcome.blockingCount > 0) lines.push(`:warning: 확인이 필요한 항목 *${outcome.blockingCount}건*`);
  type ActionsBlock = Extract<KnownBlock, { type: 'actions' }>;
  const elements: ActionsBlock['elements'] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '검토 페이지 열기', emoji: true },
      url: outcome.reviewUrl,
      action_id: 'coop:review_link',
    },
  ];
  elements.push(...buildCoopApplyButtons(outcome.token, target.env, outcome.shopCount));
  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'actions', elements },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*수정할 때는 적용할 학기를 먼저 적어주세요.*',
          '예) `!수정 방학 복지관식당 평일을 미운영으로 바꿔줘`',
          '예) `!수정 계절학기 세탁소 평일 운영시간을 11:30 - 18:30으로 바꿔줘`',
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${target.fileName} · 검토 링크는 7일 후 만료됩니다 · 요청: <@${requesterId}>` },
      ],
    },
  ];
}
export function buildRegularCoopResultBlocks(
  outcome: RegularCoopOutcome,
  target: RegularCoopTarget,
  requesterId: string,
): KnownBlock[] {
  const lines = [
    `*${target.year} ${target.termName} 생협 운영시간* 변환 완료`,
    isProduction(target.env) ? `:rotating_light: 대상: *${labelOf(target.env)}*` : `대상: ${labelOf(target.env)}`,
    `반영 대상 *${outcome.shopCount}개*`,
  ];
  if (outcome.blockingCount > 0) {
    lines.push(`:warning: 확인이 필요한 항목 *${outcome.blockingCount}건*`);
  }

  type ActionsBlock = Extract<KnownBlock, { type: 'actions' }>;
  const actionElements: ActionsBlock['elements'] = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '검토 페이지 열기', emoji: true },
      url: outcome.reviewUrl,
      action_id: 'coop:review_link',
    },
  ];
  actionElements.push(...buildCoopApplyButtons(outcome.token, target.env, outcome.shopCount));

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'actions',
      elements: actionElements,
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*잘못 추출된 값은 이 스레드에서 `!수정`으로 고칠 수 있습니다.*',
          '예) `!수정 세탁소 평일 운영시간을 11:30 - 18:30으로 바꿔줘`',
          '예) `!수정 운영 종료일을 2026-06-19로 바꿔줘`',
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${target.fileName} · 검토 링크는 7일 후 만료됩니다 · 요청: <@${requesterId}>`,
        },
      ],
    },
  ];
}
export function buildCoopApplyButtons(token: string, env: KoinEnv, shopCount: number) {
  const prod = isProduction(env);
  return [
    {
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: prod ? '프로덕션에 반영' : '반영하기',
        emoji: true,
      },
      style: prod ? undefined : ('primary' as const),
      action_id: 'coop:apply',
      value: JSON.stringify({ token }),
      ...(prod
        ? {
            confirm: {
              title: { type: 'plain_text' as const, text: '프로덕션에 반영할까요?' },
              text: { type: 'mrkdwn' as const, text: `생협 매장 *${shopCount}개*를 실제 서비스에 반영합니다.` },
              confirm: { type: 'plain_text' as const, text: '반영' },
              deny: { type: 'plain_text' as const, text: '취소' },
            },
          }
        : {}),
    },
    {
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: '취소', emoji: true },
      style: 'danger' as const,
      action_id: 'coop:cancel',
      value: JSON.stringify({ token }),
    },
  ];
}

/** 식당 · 요일 · 식사 순으로 적는다. 요일이 없으면 식사 구분도 적지 않는다. */
function describePatchTarget(patch: CoopPatch): string {
  if (!patch.shopName) return patch.field === 'from_date' ? '운영 시작일' : '운영 종료일';
  const dayOfWeek = patch.dayOfWeek === 'FRIDAY' ? '금요일' : patch.dayOfWeek;
  if (!dayOfWeek) return patch.shopName;
  return [patch.shopName, dayOfWeek, patch.type].filter(Boolean).join(' · ');
}
export function buildCoopPatchBlocks(plan: CoopPatchPlan, patchToken: string, requesterId: string): KnownBlock[] {
  const lines = plan.patches.map((patch) => {
    return `*${describePatchTarget(patch)}*\n  이전: ${patch.before || '(비어 있음)'}\n  이후: ${patch.after || '(비움)'}`;
  });
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*수정 ${plan.patches.length}건*\n\n${lines.join('\n\n')}` },
    },
  ];
  if (plan.problems.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [':warning: *적용하지 않은 요청*', ...plan.problems.map((problem) => `• ${problem}`)].join('\n'),
      },
    });
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '수정 적용', emoji: true },
        style: 'primary',
        action_id: 'coop:patch_apply',
        value: JSON.stringify({ patchToken, requesterId }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '취소', emoji: true },
        action_id: 'coop:patch_cancel',
        value: JSON.stringify({ patchToken, requesterId }),
      },
    ],
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '적용하면 검토 페이지와 요청 JSON이 함께 갱신됩니다. 링크는 그대로입니다.' }],
  });
  return blocks;
}
