import { convertVacationCoopToReview } from '~/services/coop/pipeline';
import { buildVacationCoopResultBlocks } from '~/services/slack/features/coop/blocks';
import { planCoopPatches } from '~/services/coop/patch';
import { buildCoopPatchBlocks } from '~/services/slack/features/coop/blocks';
import { linkCoopThread, loadCoopReview, saveCoopPatchPlan } from '~/services/coop/reviewStore';
import { readThreadContext } from '~/utils/slackThread';
import { createCoopJob } from '~/services/coop/jobStore';
import type { EditCommandParams, MessageSetting } from '~/services/slack/types';
import { dropPendingCoopVacation, loadPendingCoopVacation } from '~/services/coop/vacationStore';
import { errorMessage } from '~/utils/errorMessage';

export const messages: MessageSetting[] = [];

export function parseVacationBoundary(text: string): string | null {
  return /^!학기구분\s+(20\d{2}-\d{2}-\d{2})\s*$/.exec(text.trim())?.[1] ?? null;
}

messages.push({
  regex: /^!학기구분/,
  async handler({ client, channel, text, user, parentTs }) {
    if (!parentTs) return;
    const pending = await loadPendingCoopVacation(channel, parentTs);
    if (!pending) return;
    const vacationStartDate = parseVacationBoundary(text);
    if (!vacationStartDate) {
      await client.chat.postMessage({
        channel,
        thread_ts: parentTs,
        text: '방학 시작일 형식을 확인해주세요.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: ':pencil: `!학기구분 YYYY-MM-DD` 형식으로 입력해주세요.' } },
        ],
      });
      return;
    }
    const placeholder = await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: '생협 방학 시간표 분리 중',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:hourglass_flowing_sand: *${vacationStartDate}* 기준으로 계절학기와 방학을 나누는 중…`,
          },
        },
      ],
    });
    const messageTs = placeholder.ts as string;
    try {
      const target = {
        env: pending.env,
        year: pending.year,
        season: pending.season,
        fileName: pending.fileName,
      };
      const outcome = await convertVacationCoopToReview(pending.raw, vacationStartDate, target);
      await dropPendingCoopVacation(channel, parentTs);
      await linkCoopThread(channel, parentTs, outcome.token);
      await createCoopJob({
        token: outcome.token,
        channelId: channel,
        threadTs: messageTs,
        year: target.year,
        term: `${target.season}계절학기·${target.season}방학`,
        sourceFile: target.fileName,
        shopCount: outcome.shopCount,
        targetEnv: target.env,
      });
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `${target.year} ${target.season} 생협 운영시간 변환 완료`,
        blocks: buildVacationCoopResultBlocks(outcome, target, user),
      });
    } catch (error) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: '생협 방학 시간표 분리 실패',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:x: *분리 실패*\n${errorMessage(error)}` } }],
      });
    }
  },
});

const EDIT_COMMAND = /^!수정/;

/** 생협 검토 스레드의 `!수정`. 스레드 주인은 `features/editCommand.ts`가 가린다. */
export async function handleCoopEdit(
  { client, channel, ts, text, user, parentTs }: EditCommandParams,
  token: string,
): Promise<void> {
  let request = text.replace(EDIT_COMMAND, '').trim();
  const stored = await loadCoopReview(token);
  if (!stored) {
    await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: '생협 검토 링크가 만료됐습니다.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: ':x: 생협 검토 링크가 만료됐습니다. 이미지를 다시 변환해주세요.' },
        },
      ],
    });
    return;
  }
  if (!stored.conversion) {
    await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: '이전 변환 결과는 수정할 수 없습니다.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':information_source: 수정 기능 배포 전에 만든 결과입니다. 이미지를 다시 변환해주세요.',
          },
        },
      ],
    });
    return;
  }
  let periodIndex: number | undefined;
  let conversion = stored.conversion;
  if (stored.periods) {
    const selected = /^(계절학기|방학)\s+/.exec(request);
    if (!selected) {
      await client.chat.postMessage({
        channel,
        thread_ts: parentTs,
        text: '수정할 학기를 적어주세요.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                ':pencil: 방학 시간표는 수정할 학기를 먼저 적어주세요.',
                '예) `!수정 방학 복지관식당 평일을 미운영으로 바꿔줘`',
                '예) `!수정 계절학기 복지관식당 평일을 11:40 - 13:30으로 바꿔줘`',
              ].join('\n'),
            },
          },
        ],
      });
      return;
    }
    periodIndex = selected[1] === '계절학기' ? 0 : 1;
    conversion = stored.periods[periodIndex].conversion;
    request = request.slice(selected[0].length).trim();
  }
  if (!request) {
    await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: '무엇을 바꿀지 적어주세요.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              ':pencil: *무엇을 바꿀지 함께 적어주세요.*',
              '예) `!수정 세탁소 평일 운영시간을 11:30 - 18:30으로 바꿔줘`',
              '예) `!수정 복지관식당 토요일을 미운영으로 바꿔줘`',
              '예) `!수정 운영 종료일을 2026-06-19로 바꿔줘`',
            ].join('\n'),
          },
        },
      ],
    });
    return;
  }

  const placeholder = await client.chat.postMessage({
    channel,
    thread_ts: parentTs,
    text: '생협 수정 요청 확인 중',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':mag: 생협 수정 요청을 확인하는 중…' },
      },
    ],
  });
  const messageTs = placeholder.ts as string;

  try {
    const context = await readThreadContext(client, channel, parentTs, ts);
    const plan = await planCoopPatches(request, conversion, context);
    if (plan.patches.length === 0) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: '수정할 내용을 찾지 못했습니다.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                ':grey_question: *수정할 내용을 찾지 못했습니다.*',
                ...plan.problems.map((problem) => `• ${problem}`),
              ].join('\n'),
            },
          },
        ],
      });
      return;
    }
    const patchToken = await saveCoopPatchPlan(token, { ...plan, periodIndex });
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `생협 수정 ${plan.patches.length}건 확인`,
      blocks: buildCoopPatchBlocks(plan, patchToken, user),
    });
  } catch (error) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: '생협 수정 요청 처리 실패',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:x: *수정 요청을 처리하지 못했습니다*\n${errorMessage(error)}`,
          },
        },
      ],
    });
  }
}
