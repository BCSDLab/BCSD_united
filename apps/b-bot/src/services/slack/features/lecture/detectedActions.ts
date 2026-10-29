import {
  collectExcelAttachments,
  downloadNoticeFile,
  dropDetected,
  fetchArticle,
  guessSemester,
  loadDetected,
  saveDetected,
} from '~/services/lecture/detected';
import type { AttachmentFile } from '~/services/lecture/detected';
import { createJob } from '~/services/lecture/jobStore';
import { labelOf, type KoinEnv } from '~/services/koin/target';
import { convertToReview } from '~/services/lecture/pipeline';
import { buildResultBlocks } from '~/services/slack/features/lecture/blocks';
import { linkThread } from '~/services/lecture/reviewStore';
import {
  beginDetected,
  chooseFileBlocks,
  convertThenRelease,
  ignoreDetected,
  readArticle,
  stopDetected,
  takeChoice,
} from '~/services/slack/detectedFlow';
import type { BlockActionSetting } from '~/services/slack/types';
import { updateSlack } from '~/utils/slackFunction';
import { errorMessage } from '~/utils/errorMessage';

/**
 * 고른 파일을 내려받아 변환하고 검토 링크까지 올린다.
 * 첨부가 하나일 때와 골랐을 때가 여기서 만난다.
 */
async function runConversion({
  client,
  channel,
  ts,
  actor,
  env,
  file,
  year,
  term,
  articleId,
}: {
  client: Parameters<BlockActionSetting['handler']>[0]['client'];
  channel: string;
  ts: string | undefined;
  actor: string;
  env: KoinEnv;
  file: AttachmentFile;
  year: number;
  term: string;
  articleId: number;
}) {
  const target = { env, year, termName: term, fileName: file.name };

  await updateSlack({
    client,
    channel,
    ts,
    text: '변환 중',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:hourglass_flowing_sand: *${year} ${term}* 변환 중…\n${labelOf(env)} · ${file.name}\n작업자: <@${actor}>`,
        },
      },
    ],
  });

  await convertThenRelease('lecture', channel, articleId, async () => {
    try {
      const buffer = await downloadNoticeFile(file.url);
      const outcome = await convertToReview(buffer, target);

      // 이 메시지 스레드에 온 수정 요청이 어느 변환 건인지 찾을 수 있게 해둔다.
      await linkThread(channel, ts ?? '', outcome.token);
      await createJob({
        token: outcome.token,
        channelId: channel,
        threadTs: ts ?? '',
        year,
        term,
        sourceFile: file.name,
        lectureCount: outcome.lectureCount,
        targetEnv: env,
      });

      await updateSlack({
        client,
        channel,
        ts,
        text: `${year} ${term} 변환 완료 · ${outcome.lectureCount}건`,
        blocks: buildResultBlocks(outcome, target, actor),
      });
    } catch (error) {
      await updateSlack({
        client,
        channel,
        ts,
        text: '변환 실패',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `:x: *변환 실패*\n${errorMessage(error)}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `${file.name} · 작업자: <@${actor}>` }] },
        ],
      });
    }
  });
}

const store = { load: loadDetected, drop: dropDetected };

/** 배치가 올린 감지 알림에서 시작하는 흐름. */
export const lectureDetectedActions: BlockActionSetting[] = [
  {
    /**
     * 배치가 올린 감지 알림의 `예`.
     *
     * 배치가 아는 건 **이 action_id와 `article_id` 하나**뿐이다. 첨부·학기·경고 문구는
     * 전부 여기서 만든다. 되돌릴 수 없는 작업을 막는 장치가 두 레포로 흩어지면,
     * 한쪽만 고쳤을 때 나머지 한쪽은 옛날 그대로 남는다.
     */
    actionId: 'lecture:detected',
    async handler(press) {
      const begun = await beginDetected('lecture', press, {
        feature: '강의',
        notTarget: '대상 아님',
        started: '진행합니다',
        startedTitle: '강의 업데이트를 진행합니다.',
        checking: '게시글 확인 중',
        checkingNotice: ':hourglass_flowing_sand: 게시글을 확인하고 있습니다…',
      });
      if (!begun) return;
      const { target, articleId, channel, actor, ts } = begun;

      const article = await readArticle(begun, fetchArticle, '게시글 조회 실패');
      if (!article) return;

      const files = collectExcelAttachments(article.attachments);
      if (files.length === 0) {
        await stopDetected(begun, '첨부 없음', [
          ':grey_question: *엑셀 첨부를 찾지 못했습니다.*',
          `<${article.link}|${article.name}>`,
          '파일을 직접 올리고 `!강의반영 2026 여름학기`로 실행해주세요.',
        ]);
        return;
      }

      // 학기를 모르면 진행하지 않는다. 엉뚱한 학기에 넣으면 되돌릴 수 없다.
      const semester = guessSemester(article.title ?? '');
      if (!semester) {
        await stopDetected(begun, '학기를 지정해주세요', [
          ':grey_question: *제목에서 학기를 읽지 못했습니다.*',
          '엑셀을 내려받아 `!강의반영 2026 여름학기`처럼 직접 올려주세요.',
          ...files.map((file) => `<${file.url}|${file.name}>`),
        ]);
        return;
      }

      // 엑셀이 여럿이면 사람이 고른다. 편람 외에 폐강강좌·시간표가 함께 붙는다.
      if (files.length > 1) {
        const token = await saveDetected({
          target: target.env,
          articleId,
          articleTitle: article.name,
          articleUrl: article.link,
          files,
          ...semester,
        });
        await updateSlack({
          client: press.client,
          channel,
          ts,
          text: '변환할 파일을 골라주세요',
          blocks: chooseFileBlocks({
            heading: [
              `:page_facing_up: *${semester.year} ${semester.term}* · ${target.label}`,
              `엑셀 첨부가 *${files.length}개* 입니다. 변환할 파일을 골라주세요.`,
            ],
            files,
            actionPrefix: 'lecture:detected',
            token,
          }),
        });
        return;
      }

      await runConversion({
        client: press.client,
        channel,
        ts,
        actor,
        env: target.env,
        file: files[0],
        ...semester,
        articleId,
      });
    },
  },
  // 엑셀이 여럿일 때 고른 파일로 이어간다. 버튼마다 action_id가 달라야 해서 나눠 둔다.
  ...[0, 1, 2, 3].map((slot): BlockActionSetting => ({
    actionId: slot === 0 ? 'lecture:detected_start' : `lecture:detected_start_${slot}`,
    async handler(press) {
      // 학기를 모르는 알림은 고르기 단계까지 오지 않지만, 저장값이 깨졌으면 만료로 본다.
      const choice = await takeChoice(
        store,
        press,
        (detected, index) => (detected.year && detected.term ? detected.files[index] : undefined),
        ':x: 이미 처리했거나 만료된 알림입니다.',
      );
      if (!choice) return;
      const { detected } = choice;
      await runConversion({
        client: press.client,
        channel: press.body.channel!.id,
        ts: choice.ts,
        actor: press.body.user.id,
        env: detected.target,
        file: choice.file,
        year: detected.year,
        term: detected.term,
        articleId: detected.articleId,
      });
    },
  })),
  {
    actionId: 'lecture:detected_ignore',
    async handler(press) {
      await ignoreDetected('lecture', store, press, { text: '무시함', title: '이 공지는 넘어갑니다.' });
    },
  },
];
