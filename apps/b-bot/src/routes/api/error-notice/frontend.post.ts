import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { kstDateKey } from '~/utils/kstDate';
import { sendSlackBlock } from '~/utils/slackFunction';

interface RequestBody {
  url: string;
  error: unknown;
}

interface ErrorInfo {
  ts: string;
  error: string;
  url: string;
}

const FRONTEND_ERROR_PREFIX = 'FRONTEND_ERROR';

export default defineEventHandler(async (event) => {
  try {
    const { url, error } = await readBody<RequestBody>(event);

    let channel = CHANNEL_ID.코인_오류_front_end;

    if (url.includes('stage.') || url.includes('localhost')) {
      channel = CHANNEL_ID.코인_오류_front_end_stage;
    }
    const storage = useStorage('kvStorage');
    const key = `${FRONTEND_ERROR_PREFIX}_${kstDateKey()}`;
    const errorString = JSON.stringify(error);
    const hasSameError = await storage.get<ErrorInfo[]>(`frontend-error-${key}`);
    const threadTs = hasSameError?.find((item) => item.url === url || item.error === errorString)?.ts ?? undefined;

    const result = await sendSlackBlock({
      client: event.context.slackWebClient,
      channel,
      unfurlLinks: false,
      threadTs,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `
  :rotating_light: 클라이언트 에러가 발생했어요 :rotating_light:
  
  url: \`${url}\`
  error: 
  \`\`\`${errorString}\`\`\`
   `,
          },
        },
      ],
    });
    if (!threadTs) {
      await storage.set<ErrorInfo[]>(`frontend-error-${key}`, [
        ...(hasSameError ?? []),
        {
          ts: result.ts,
          error: errorString,
          url,
        },
      ]);
    }

    return 'OK';
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: `Error: ${error}`,
    });
  }
});
