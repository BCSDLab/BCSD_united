import { createJob } from '~/services/lecture/jobStore';
import { resolveTarget } from '~/services/koin/target';
import { planPatches } from '~/services/lecture/patch';
import { convertToReview } from '~/services/lecture/pipeline';
import { buildPatchBlocks, buildResultBlocks } from '~/services/slack/features/lecture/blocks';
import { findTokenByThread, linkThread, loadReview, savePatchPlan } from '~/services/lecture/reviewStore';
import { downloadSlackFile, findExcelFile } from '~/utils/slackFile';
import { readThreadContext, threadRootOf } from '~/utils/slackThread';
import { postEditHelp } from '~/services/slack/features/editHelp';
import type { EditCommandParams, MessageSetting } from '~/services/slack/types';
import { errorMessage } from '~/utils/errorMessage';

const COMMAND = /^!강의반영/;
/** `!강의반영 2026 여름학기` */
const ARGS = /^!강의반영\s+(\d{4})\s*(1학기|2학기|여름학기|겨울학기)\s*$/;

/** 사람이 직접 치는 값이라 규칙을 한 곳에 모아두고 테스트로 고정한다. */
export function parseCommand(text: string): { year: number; termName: string } | null {
  const matched = ARGS.exec(text.trim());
  return matched ? { year: Number(matched[1]), termName: matched[2] } : null;
}

const USAGE = [
  '*사용법* — 엑셀 파일을 올리면서 메시지에 함께 적어주세요.',
  '```!강의반영 2026 여름학기```',
  '학기는 `1학기` `2학기` `여름학기` `겨울학기` 중 하나입니다.',
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
      // 덮어쓰는 대신 막는다. 만료돼 조회되지 않는 건 막을 이유가 없다.
      if (parentTs) {
        const existing = await findTokenByThread(channel, threadRoot);
        if (existing && (await loadReview(existing))) {
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
      const resolved = resolveTarget(channel, '강의');
      if (!resolved.target) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadRoot,
          text: '이 채널은 강의 반영 대상이 아닙니다.',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:no_entry: ${resolved.reason}` },
            },
          ],
        });
        return;
      }

      const parsed = parseCommand(text);
      const excel = findExcelFile(files);

      if (!parsed || !excel) {
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
                  !excel ? ':file_folder: 엑셀 파일(.xlsx)을 함께 올려주세요.' : null,
                  !parsed ? ':pencil: 연도와 학기를 적어주세요.' : null,
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

      const target = { ...parsed, env: resolved.target.env, fileName: excel.name };

      // 변환은 LLM 호출과 파싱이 걸려 수십 초가 나올 수 있다.
      // 먼저 붙잡아두지 않으면 사람들이 명령어를 또 친다.
      const placeholder = await client.chat.postMessage({
        channel,
        thread_ts: threadRoot,
        text: '변환 중',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:hourglass_flowing_sand: *${target.year} ${target.termName}* 변환 중…\n${resolved.target.label} · ${excel.name}`,
            },
          },
        ],
      });
      const messageTs = placeholder.ts as string;

      try {
        const buffer = await downloadSlackFile(excel);
        const outcome = await convertToReview(buffer, target);

        // 이 스레드에 온 수정 요청이 어느 변환 건인지 찾을 수 있게 해둔다.
        await linkThread(channel, threadRoot, outcome.token);
        // 반영 권한을 한 명만 갖게 하려면 상태가 DB에 있어야 한다.
        await createJob({
          token: outcome.token,
          channelId: channel,
          threadTs: threadRoot,
          year: target.year,
          term: target.termName,
          sourceFile: target.fileName,
          lectureCount: outcome.lectureCount,
          targetEnv: target.env,
        });

        await client.chat.update({
          channel,
          ts: messageTs,
          text: `${target.year} ${target.termName} 변환 완료 · ${outcome.lectureCount}건`,
          blocks: buildResultBlocks(outcome, target, user),
        });
      } catch (error) {
        // 실패해도 원래 메시지를 갱신한다. 새 메시지를 쌓으면 어느 게 최신인지 헷갈린다.
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
              elements: [{ type: 'mrkdwn', text: `${excel.name} · 요청: <@${user}>` }],
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

/** 강의 검토 스레드의 `!수정`. 스레드 주인은 `features/editCommand.ts`가 가린다. */
export async function handleLectureEdit(
  { client, channel, ts, text, user, parentTs }: EditCommandParams,
  token: string,
): Promise<void> {
  const request = text.replace(EDIT_COMMAND, '').trim();
  const stored = await loadReview(token);
  // 스레드는 강의 것인데 검토가 만료됐으면 어디서 다시 해야 하는지 알려준다.
  if (!stored) {
    await postEditHelp({ client, channel, ts }, { inThread: true });
    return;
  }

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
              '예) `!수정 유체역학 03 담당교수를 우창규로 바꿔줘`',
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
    const plan = await planPatches(request, stored.lectures, stored.timeFormat, context);

    if (plan.patches.length === 0 && plan.ambiguities.length === 0) {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: '수정할 내용을 찾지 못했습니다',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [':grey_question: *수정할 내용을 찾지 못했습니다.*', ...plan.problems.map((p) => `• ${p}`)].join(
                '\n',
              ),
            },
          },
        ],
      });
      return;
    }

    const patchToken = await savePatchPlan(token, plan);
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `수정 ${plan.patches.length}건 확인`,
      blocks: buildPatchBlocks(plan, patchToken, user),
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
