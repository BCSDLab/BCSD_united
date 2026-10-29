import type { View } from '@slack/web-api';
import INTERACTION_MODAL from '@/constant/INTERACTION_MODAL.json';
import type { CommandSetting, ViewActionSetting } from '~/services/slack/types';
import { sendSlackText } from '~/utils/slackFunction';

/** 강의 공지 모달(`/강의공지`). */
export const commands: CommandSetting[] = [
  {
    command: '/강의공지',
    async handler({ client, command }) {
      const threadChannelId = command.channel_id;
      await client.views.open({
        trigger_id: command.trigger_id,
        view: {
          ...(INTERACTION_MODAL.강의공지.view as View),
          private_metadata: threadChannelId,
        },
      });
    },
  },
];

export const viewActions: ViewActionSetting[] = [
  {
    actionId: INTERACTION_MODAL.강의공지.callback_id,
    async handler({ client, action: { view } }) {
      const threadChannelId = view['private_metadata'];
      const content = view['state']['values']['content']['content_input']['value'];
      const location = view['state']['values']['location']['location_input']['value'];
      const day = view['state']['values']['day']['day_dropdown']['selected_option'];
      const time = view['state']['values']['time']['time_dropdown']['selected_option'];
      const online = view['state']['values']['checkbox_block']['checkbox_input'];

      // 스레드에 멘션
      await sendSlackText({
        client,
        channel: threadChannelId,
        text: `*비기너 강의 공지*\n${content}\n*장소*: ${location}\n*요일*: ${day?.text.text}\n*시간*: ${time?.text.text}\n*온라인여부*: ${online ? '온라인' : '오프라인'}\n`,
      });
    },
  },
];
