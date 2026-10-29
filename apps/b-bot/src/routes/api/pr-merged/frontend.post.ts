import { getPRThread, markPRThreadMerged } from '~/services/github/prThreadStore';
import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { getMembersOrEmpty, mentionByName } from '~/services/member/members';
import { sendSlackBlock } from '~/utils/slackFunction';

interface RequestBody {
  pullRequestLink: string;
}

// 각 저장소의 CHECK_PR_MERGED 워크플로는 링크만 보낸다. 리뷰어·작성자는 리뷰어 지정 때 남긴 pr_thread에서 찾는다.
export default defineEventHandler(async (event) => {
  const { pullRequestLink } = await readBody<RequestBody>(event);
  const pool = event.context.sqlPool;

  // 리뷰어 지정 알림이 없던 PR(봇 도입 전, 리뷰어 자동 지정 없는 저장소)은 스레드가 없다. 새 글을 띄우지 않는다.
  const thread = await getPRThread(pool, pullRequestLink);
  if (!thread) {
    return 'SKIPPED';
  }
  // 워크플로 재실행으로 같은 PR이 다시 오면 답글을 또 달지 않는다.
  if (thread.merged) {
    return 'ALREADY_MERGED';
  }

  const members = await getMembersOrEmpty();
  const writerMentionString = thread.writer ? mentionByName(members, thread.writer, 'FrontEnd') : '-';
  const mentionString = thread.reviewers.map((reviewer) => mentionByName(members, reviewer, 'FrontEnd')).join(', ');

  await sendSlackBlock({
    client: event.context.slackWebClient,
    channel: CHANNEL_ID.frontend_github,
    threadTs: thread.ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `
*리뷰 완료! 고생하셨습니다~ :raising_hands:*
• ~리뷰하러 가기 >>~ <${pullRequestLink}|click>
• 담당자 : ${writerMentionString}
• 리뷰어 : ${mentionString}`,
        },
      },
    ],
  });
  await markPRThreadMerged(pool, pullRequestLink);

  return 'OK';
});
