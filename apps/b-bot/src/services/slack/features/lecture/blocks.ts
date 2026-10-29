import type { KnownBlock } from '@slack/web-api';
import type { PatchPlan } from '~/services/lecture/patch';
import { isProduction, labelOf } from '~/services/koin/target';
import { describeClassTime } from '~/services/lecture/describeTime';
import type { ConversionOutcome, ConversionTarget } from '~/services/lecture/pipeline';

/**
 * 변환 결과 안내. 확인이 필요한 게 있으면 반영 버튼을 아예 내리지 않고 경고를 붙인다.
 * 판단은 사람이 하되, 무엇을 감수하는지는 보이게 한다.
 */
export function buildResultBlocks(
  outcome: ConversionOutcome,
  target: ConversionTarget,
  requesterId: string,
): KnownBlock[] {
  const warn = outcome.blockingCount > 0 || outcome.parseFailureCount > 0;

  const prod = isProduction(target.env);
  const lines = [
    `*${target.year} ${target.termName}* 변환 완료`,
    // 어디에 들어가는지가 가장 중요한 정보다. 프로덕션은 되돌릴 수 없다.
    prod ? `:rotating_light: 대상: *${labelOf(target.env)}*` : `대상: ${labelOf(target.env)}`,
    `강의 *${outcome.lectureCount}건* · 시간 없음 ${outcome.withoutTimeCount}건`,
  ];
  if (outcome.parseFailureCount > 0) {
    lines.push(`:warning: 강의시간 해석 실패 *${outcome.parseFailureCount}건*`);
  }
  if (outcome.blockingCount > 0) {
    lines.push(`:warning: 반영을 막는 항목 *${outcome.blockingCount}건*`);
  }
  if (outcome.emptyValueCount > 0) {
    // 반영은 되지만 원본이 비어 있다는 사실은 알고 넘어가야 한다.
    lines.push(`엑셀에 값이 없는 항목 ${outcome.emptyValueCount}건 (빈 값으로 반영)`);
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '검토 페이지 열기', emoji: true },
          url: outcome.reviewUrl,
          action_id: 'lecture:review_link',
        },
        {
          type: 'button',
          // 누르는 순간에도 어디에 넣는지 보이게 한다.
          text: {
            type: 'plain_text',
            text: `${prod ? '프로덕션에 ' : ''}${warn ? '그래도 반영' : '반영'}`,
            emoji: true,
          },
          style: warn || prod ? undefined : 'primary',
          action_id: 'lecture:apply',
          value: JSON.stringify({ token: outcome.token, requesterId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '취소', emoji: true },
          style: 'danger',
          action_id: 'lecture:cancel',
          value: JSON.stringify({ token: outcome.token, requesterId }),
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            '*수정이 필요하면 이 스레드에 `!수정`으로 말씀해주세요.*',
            '예) `!수정 유체역학 03 담당교수를 우창규로 바꿔줘`',
            '예) `!수정 MEB321 01 강의시간을 월9교시~10교시로 바꿔줘`',
            '시각으로 지정하려면 `09:00~10:00`처럼 적어주세요.',
          ].join('\n'),
        },
      ],
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
/**
 * 적용 전 미리보기. 무엇이 무엇으로 바뀌는지 전부 보여준 뒤 한 번 더 누르게 한다.
 * 되돌릴 API가 없어서, 틀린 수정이 조용히 들어가는 것만은 막아야 한다.
 */
export function buildPatchBlocks(plan: PatchPlan, patchToken: string, requesterId: string): KnownBlock[] {
  // 교시인지 시각인지 못 정한 게 있으면 그것부터 고르게 한다.
  // 다시 타이핑하게 하는 대신 이미 계산해둔 두 해석 중 하나를 누르면 된다.
  if (plan.ambiguities.length > 0) {
    return buildAmbiguityBlocks(plan, patchToken, requesterId);
  }

  const lines = plan.patches.map((patch) => {
    const where = `${patch.lecture.code} ${patch.lecture.lecture_class} ${patch.lecture.name}`;
    return [
      `*${where}* — ${patch.label}`,
      `  이전: ${patch.before || '(비어 있음)'}`,
      `  이후: ${patch.after || '(비움)'}`,
    ].join('\n');
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
        text: [':warning: *반영하지 않은 요청*', ...plan.problems.map((p) => `• ${p}`)].join('\n'),
      },
    });
  }

  blocks.push(
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '수정 적용', emoji: true },
          style: 'primary',
          action_id: 'lecture:patch_apply',
          value: JSON.stringify({ patchToken, requesterId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '취소', emoji: true },
          action_id: 'lecture:patch_cancel',
          value: JSON.stringify({ patchToken, requesterId }),
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `적용하면 검토 페이지가 갱신됩니다. 링크는 그대로입니다.` }],
    },
  );

  return blocks;
}
function buildAmbiguityBlocks(plan: PatchPlan, patchToken: string, requesterId: string): KnownBlock[] {
  const lines = plan.ambiguities.map((item) => {
    const where = `${item.lecture.code} ${item.lecture.lecture_class} ${item.lecture.name}`;
    return [
      `*${where}* — "${item.rawValue}"`,
      `  교시로 → ${describeClassTime(item.asPeriod.infos)}`,
      `  시각으로 → ${describeClassTime(item.asClock.infos)}`,
    ].join('\n');
  });

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*교시인지 시각인지 정해주세요*\n\n${lines.join('\n\n')}`,
      },
    },
  ];

  if (plan.patches.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `함께 적용될 수정 ${plan.patches.length}건이 더 있습니다.` }],
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '교시로', emoji: true },
        action_id: 'lecture:time_period',
        value: JSON.stringify({ patchToken, requesterId }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '시각으로', emoji: true },
        action_id: 'lecture:time_clock',
        value: JSON.stringify({ patchToken, requesterId }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '취소', emoji: true },
        style: 'danger',
        action_id: 'lecture:patch_cancel',
        value: JSON.stringify({ patchToken, requesterId }),
      },
    ],
  });

  return blocks;
}
