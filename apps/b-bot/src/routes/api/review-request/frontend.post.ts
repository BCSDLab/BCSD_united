import { getPRThreadTs, savePRThread } from '~/services/github/prThreadStore';
import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { getMembersOrEmpty, mentionByName } from '~/services/member/members';
import { sendSlackBlock } from '~/utils/slackFunction';

interface RequestBody {
  pullRequestLink: string;
  reviewers: string[];
  writer: string;
}

export default defineEventHandler(async (event) => {
  const { pullRequestLink, reviewers, writer } = await readBody<RequestBody>(event);

  const members = await getMembersOrEmpty();
  const writerMentionString = mentionByName(members, writer, 'FrontEnd');
  const mentionString = reviewers.map((reviewer) => mentionByName(members, reviewer, 'FrontEnd')).join(', ');

  const threadTs = await getPRThreadTs(event.context.sqlPool, pullRequestLink);

  const result = await sendSlackBlock({
    client: event.context.slackWebClient,
    channel: CHANNEL_ID.frontend_github,
    threadTs: threadTs ?? undefined,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: threadTs
            ? `
*리뷰가 다시 요청되었습니다! :blob-wave:*
 • 리뷰하러 가기 >> <${pullRequestLink}|click>
 • 담당자 : ${writerMentionString}
 • 리뷰어 : ${mentionString}`
            : `
*리뷰어가 할당되었습니다! :blob-wave:*
 • 리뷰하러 가기 >> <${pullRequestLink}|click>
 • 담당자 : ${writerMentionString}
 • 리뷰어 : ${mentionString}`,
        },
      },
    ],
  });
  if (!threadTs && result.ts) {
    await savePRThread({
      pool: event.context.sqlPool,
      ts: result.ts,
      pullRequestLink,
      reviewers,
      writer,
    });
  }

  return 'OK';
});
