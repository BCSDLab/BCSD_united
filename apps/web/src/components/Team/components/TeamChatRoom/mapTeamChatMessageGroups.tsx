import type { ChatMessageResponse } from 'api/chat/entity';
import groupChatMessagesByDate from 'components/Team/utils/groupChatMessagesByDate';
import type { ChatMessageListGroup } from 'components/ui/Chat';
import { formatChatTime } from 'utils/ts/chatTime';

import TeamChatSenderAvatar from './TeamChatSenderAvatar';

export default function mapTeamChatMessageGroups(
  messages: ChatMessageResponse[],
  currentUserId: number | undefined,
): ChatMessageListGroup[] {
  return groupChatMessagesByDate(messages).map((group) => ({
    key: group.date,
    dateLabel: group.label,
    messages: group.messages.map((message) => ({
      key: message.message_id,
      messageId: message.message_id,
      isMine: message.user_id === currentUserId,
      content: message.content,
      isImage: message.is_image,
      timeLabel: formatChatTime(message.timestamp),
      unreadCount: message.unread_count,
      senderId: message.user_id,
      senderName: message.user_nickname ?? undefined,
      senderAvatar: <TeamChatSenderAvatar />,
    })),
  }));
}
