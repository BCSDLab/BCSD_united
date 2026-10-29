import { createBusJob } from '~/services/bus/jobStore';
import { planBusPatches } from '~/services/bus/patch';
import { convertBusToReview } from '~/services/bus/pipeline';
import { buildBusPatchBlocks, buildReviewApprovalBlocks } from '~/services/slack/features/bus/blocks';
import { findBusTokenByThread, linkBusThread, loadBusReview, saveBusPatchPlan } from '~/services/bus/reviewStore';
import { resolveTarget } from '~/services/koin/target';
import { downloadSlackSpreadsheet, findSpreadsheetFiles } from '~/utils/slackFile';
import { readThreadContext, threadRootOf } from '~/utils/slackThread';
import type { EditCommandParams, MessageSetting } from '~/services/slack/types';
import { errorMessage } from '~/utils/errorMessage';

const COMMAND = /^!버스반영/;
/** `!버스반영` — 버스 명령은 파일 첨부만 받으므로 완전 일치만 인정한다. */
const ARGS = /^!버스반영\s*$/;

/** 사람이 직접 치는 값이라 규칙을 한 곳에 모아두고 테스트로 고정한다. */
export function parseBusCommand(text: string): boolean {
  return ARGS.test(text.trim());
}

const USAGE = [
  '*사용법* — 버스 시간표 파일을 올리면서 메시지에 함께 적어주세요.',
  '```!버스반영```',
  '지원 형식은 `.xls` `.xlsx`입니다.',
].join('\n');

export const messages: MessageSetting[] = [
  {
    regex: COMMAND,
    acceptsFiles: true,
    async handler({ client, channel, ts, text, user, files, parentTs }) {
      // 스레드 안에서 다시 실행할 수도 있다. 그때 ts는 그 답글 자신의 것이라
      // 스레드를 대표하는 값(루트)으로 맞춰야 !수정이 찾아갈 수 있다.
      const threadRoot = threadRootOf(ts, parentTs);

      // 한 스레드에 변환이 둘이면 !수정이 어느 것에 적용되는지 헷갈린다.
      if (parentTs) {
        const existing = await findBusTokenByThread(channel, threadRoot);
        if (existing && (await loadBusReview(existing))) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadRoot,
            text: '이 스레드에는 이미 변환 결과가 있습니다.',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    ':no_entry: *이 스레드에는 이미 변환 결과가 있습니다.*',
                    '새 메시지로 시작해주세요. 한 스레드에 둘이 있으면 `!수정`이 어느 것에 적용되는지 알 수 없습니다.',
                  ].join('\n'),
                },
              },
            ],
          });
          return;
        }
      }

      // 어느 코인에 반영할지는 채널이 정한다. 모르는 채널이면 진행하지 않는다.
      const resolved = resolveTarget(channel, '버스');
      if (!resolved.target) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadRoot,
          text: '이 채널은 버스 반영 대상이 아닙니다.',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:no_entry: ${resolved.reason}` } }],
        });
        return;
      }

      // 여러 개를 올리면 어느 걸 변환해야 하는지 봇도 사용자도 알 방법이 없다.
      // 예전엔 첫 번째만 조용히 골라서, 두 번째 파일이 그냥 무시된 채로 넘어갔다.
      const spreadsheets = findSpreadsheetFiles(files);
      if (spreadsheets.length > 1) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadRoot,
          text: '파일이 여러 개입니다.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  `:warning: *시간표 파일이 ${spreadsheets.length}개 올라왔습니다.*`,
                  spreadsheets.map((f) => `• ${f.name}`).join('\n'),
                  '하나만 올려주세요. 여러 파일 중 어느 걸 반영해야 할지 정할 수 없습니다.',
                ].join('\n'),
              },
            },
          ],
        });
        return;
      }

      const file = spreadsheets[0] ?? null;
      if (!parseBusCommand(text) || !file) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadRoot,
          text: '사용법을 확인해주세요.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  !file ? ':file_folder: 버스 시간표 파일(xls/xlsx)을 함께 올려주세요.' : null,
                  !parseBusCommand(text) ? ':pencil: `!버스반영`만 입력해주세요.' : null,
                  '',
                  USAGE,
                ]
                  .filter((line) => line !== null)
                  .join('\n'),
              },
            },
          ],
        });
        return;
      }

      const target = { env: resolved.target.env, fileName: file.name };
      const placeholder = await client.chat.postMessage({
        channel,
        thread_ts: threadRoot,
        text: '변환 중',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:hourglass_flowing_sand: *버스 시간표* 변환 중…\n${resolved.target.label} · ${file.name}`,
            },
          },
        ],
      });
      const messageTs = placeholder.ts as string;

      try {
        const bytes = await downloadSlackSpreadsheet(file);
        const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
        const outcome = await convertBusToReview(bytes, extension, target);

        // 반영 권한을 한 명만 갖게 하려면 상태가 DB에 있어야 한다. job 행이 없는데
        // 스레드부터 묶으면, 여기서 실패했을 때 스레드가 막다른 곳이 된다
        // (재실행하면 "이미 변환 결과가 있다"고 막히는데 정작 반영 버튼은 없다).
        await createBusJob({
          token: outcome.token,
          channelId: channel,
          threadTs: threadRoot,
          sourceFile: target.fileName,
          routeCount: outcome.routeCount,
          semesterTypes: outcome.semesterTypes,
          targetEnv: target.env,
        });
        // 이 스레드에 온 수정 요청이 어느 변환 건인지 찾을 수 있게 해둔다.
        await linkBusThread(channel, threadRoot, outcome.token);

        await client.chat.update({
          channel,
          ts: messageTs,
          text: `버스 시간표 변환 완료 · ${outcome.routeCount}개`,
          blocks: buildReviewApprovalBlocks(outcome, target, user),
        });
      } catch (error) {
        await client.chat.update({
          channel,
          ts: messageTs,
          text: '변환 실패',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:x: *변환 실패*\n${errorMessage(error)}`,
              },
            },
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `${file.name} · 요청: <@${user}>` }],
            },
          ],
        });
      }
    },
  },
];

/**
 * 검토 중 발견한 수정 사항을 스레드에 자연어로 적으면 받는다.
 * 명령어 접두사를 두지 않은 건, 이미 그 스레드가 어느 변환 건인지 정해져 있어서다.
 */
const EDIT_COMMAND = /^!수정/;

/** 버스 검토 스레드의 `!수정`. 스레드 주인은 `features/editCommand.ts`가 가린다. */
export async function handleBusEdit(
  { client, channel, ts, text, user, parentTs }: EditCommandParams,
  token: string,
): Promise<void> {
  const request = text.replace(EDIT_COMMAND, '').trim();
  const stored = await loadBusReview(token);
  // 검토가 만료된 버스 스레드에서는 조용히 빠진다(기존 동작).
  if (!stored) return;

  if (request === '') {
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
              '예) `!수정 천안역 1회 터미널 시간을 08:05로 바꿔줘`',
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
    text: '수정 요청 확인 중',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':mag: 수정 요청을 확인하는 중…' } }],
  });
  const messageTs = placeholder.ts as string;

  try {
    const context = await readThreadContext(client, channel, parentTs, ts);
    const plan = await planBusPatches(request, stored.conversions, context);

    if (plan.patches.length === 0) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: '수정할 내용을 찾지 못했습니다',
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

    const patchToken = await saveBusPatchPlan(token, {
      patches: plan.patches,
      problems: plan.problems,
      request,
    });
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `수정 ${plan.patches.length}건 확인`,
      blocks: buildBusPatchBlocks(plan, patchToken, user),
    });
  } catch (error) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: '수정 요청 처리 실패',
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
