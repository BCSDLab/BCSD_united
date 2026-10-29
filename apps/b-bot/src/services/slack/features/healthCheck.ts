import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import type { CommandSetting } from '~/services/slack/types';
import { sendSlackText } from '~/utils/slackFunction';

/** 서버가 살아 있는지 확인하는 `/test`. */
export const commands: CommandSetting[] = [
  {
    command: '/test',
    execution: 'queue',
    async handler({ client }) {
      await sendSlackText({
        client,
        channel: CHANNEL_ID.삐봇요청_test,
        text: '테스트 서버 멀쩡함',
      });
    },
  },
];
