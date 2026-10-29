import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { resolvePackageName } from '~/services/package/packageName';
import { sendSlackBlock, sendSlackText } from '~/utils/slackFunction';

interface RequestBody {
  pullRequestLink: string;
  pullRequestTitle: string;
  packageName?: string;
  /** @deprecated 예전 단일 패키지 저장소용. 새 워크플로는 packageName을 보낸다. */
  repositoryName?: string;
  version: string;
}

export default defineEventHandler(async (event) => {
  const {
    pullRequestLink,
    pullRequestTitle,
    packageName: requestedPackageName,
    repositoryName,
    version,
  } = await readBody<RequestBody>(event);
  const packageName = resolvePackageName({ packageName: requestedPackageName, repositoryName });

  if (!packageName) {
    const detail = `${requestedPackageName ?? repositoryName}, ${pullRequestLink}, ${pullRequestTitle}, ${version}`;
    await sendSlackText({
      client: event.context.slackWebClient,
      channel: CHANNEL_ID.트랙_front_end,
      text: `패키지가 배포되었지만, 패키지 이름을 찾을 수 없어요., ${detail}`,
      unfurlLinks: true,
    });

    throw createError({
      statusCode: 500,
      statusMessage: `패키지가 배포되었지만, 패키지 이름을 찾을 수 없어요., ${detail}`,
    });
  }

  await sendSlackBlock({
    client: event.context.slackWebClient,
    channel: CHANNEL_ID.트랙_front_end,
    unfurlLinks: true,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: `${packageName} 패키지가 업데이트됐어요!`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `
  서비스별 확인 후 업데이트 부탁드려요 :meow_cookie:
   • <${pullRequestLink}|${pullRequestTitle}>`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: `yarn add ${packageName}@^${version}`,
          emoji: true,
        },
      },
    ],
  });
  return 'OK';
});
