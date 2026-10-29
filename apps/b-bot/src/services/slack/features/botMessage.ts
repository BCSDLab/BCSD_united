import type { View } from '@slack/web-api';
import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import INTERACTION_MODAL from '@/constant/INTERACTION_MODAL.json';
import type { MentionMetadata, ShortcutSetting, ViewActionSetting } from '~/services/slack/types';
import { sendSlackText } from '~/utils/slackFunction';

/** 삐봇 이름으로 메시지를 대신 보내는 숏컷·모달. */
export const shortcuts: ShortcutSetting[] = [
  {
    key: 'b-bot_message',
    async handler({ client, shortcut }) {
      if (shortcut.type !== 'message_action') return;
      const { channel, message, user } = shortcut;
      const rootTs = message.thread_ts || message.ts;
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: {
          ...(INTERACTION_MODAL.삐봇메세지.view as View),
          private_metadata: JSON.stringify({
            channel: channel.id,
            thread_ts: rootTs,
            user_id: user.id,
          }),
        },
      });
    },
  },
];

export const viewActions: ViewActionSetting[] = [
  {
    actionId: INTERACTION_MODAL.삐봇메세지.callback_id,
    async handler({ client, action: { view } }) {
      const metadata = JSON.parse(view.private_metadata) as MentionMetadata;
      const channelId = metadata.channel;
      const threadTs = metadata.thread_ts;
      const userId = metadata.user_id;

      const userInput = view.state.values['bbot_message_block']['bbot_message_input']?.value?.trim() || '';
      const selectedUserIds =
        view.state.values['bbot_users_select_block']['bbot_users_select_input'].selected_users || [];

      const mentionText = selectedUserIds.length > 0 ? selectedUserIds.map((id: string) => `<@${id}>`).join(' ') : '';

      const finalMessage = mentionText ? `${mentionText} ${userInput}` : `${userInput}`;

      await sendSlackText({
        client,
        channel: channelId,
        threadTs: threadTs,
        text: finalMessage,
      });

      await sendSlackText({
        client,
        channel: CHANNEL_ID.삐봇_log,
        text: `<@${userId}>님의 삐봇 메시지!\n${finalMessage}`,
      });
    },
  },
];
