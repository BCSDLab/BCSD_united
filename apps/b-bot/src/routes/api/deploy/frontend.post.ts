import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { getMembersOrEmpty, mentionByName } from '~/services/member/members';
import { sendSlackBlock } from '~/utils/slackFunction';

interface RequestBody {
  status: 'success' | 'failure';
  environment: 'Production' | 'Stage';
  repository: string;
  branch: string;
  actor: string;
  commitMessage: string;
  runUrl: string;
}

export default defineEventHandler(async (event) => {
  const { status, environment, repository, branch, actor, commitMessage, runUrl } = await readBody<RequestBody>(event);

  const members = await getMembersOrEmpty();
  const actorMentionString = mentionByName(members, actor, 'FrontEnd');

  const isSuccess = status === 'success';
  const icon = isSuccess ? ':white_check_mark:' : ':x:';
  const statusText = isSuccess ? '배포 성공' : '배포 실패';

  await sendSlackBlock({
    client: event.context.slackWebClient,
    channel: CHANNEL_ID.알림_deploy,
    unfurlLinks: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${icon} *[${environment}] ${statusText}*\n• Repo: \`${repository}\`\n• Branch: \`${branch}\`\n• Author: ${actorMentionString}\n• Commit: ${commitMessage}\n• <${runUrl}|Actions 보기>`,
        },
      },
    ],
  });

  return 'OK';
});
