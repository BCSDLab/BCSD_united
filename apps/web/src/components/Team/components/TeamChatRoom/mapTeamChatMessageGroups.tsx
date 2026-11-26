import type { ChatMessageResponse } from 'api/chat/entity';
import { fetchChatMessageSourceVersion, teamRecruitmentMessageTranslationPath } from 'api/chat/translation';
import groupChatMessagesByDate from 'components/Team/utils/groupChatMessagesByDate';
import type { ChatMessageListGroup, ChatMessageTranslation } from 'components/ui/Chat';
import { formatChatTime } from 'utils/ts/chatTime';

import TeamChatSenderAvatar from './TeamChatSenderAvatar';

interface TeamChatRoomTranslationTarget {
  roomId: string;
  recruitmentId: number;
  chatRoomId: number;
}

export default function mapTeamChatMessageGroups(
  messages: ChatMessageResponse[],
  currentUserId: number | undefined,
  room: TeamChatRoomTranslationTarget,
): ChatMessageListGroup[] {
  const nextMessageIds = new Map(
    messages.map((message, index) => [message.message_id, messages[index + 1]?.message_id]),
  );

  // 상대가 보낸 텍스트 쪽지만 번역한다. 내 정보를 받기 전에는 내 메시지인지 알 수 없으므로 붙이지 않는다.
  const getTranslation = (message: ChatMessageResponse): ChatMessageTranslation | undefined => {
    if (currentUserId === undefined || message.user_id === currentUserId || message.is_image) return undefined;

    return {
      resourceType: 'RECRUITMENT_MESSAGE',
      resourceId: message.message_id,
      parentId: room.recruitmentId,
      roomId: room.chatRoomId,
      translatePath: teamRecruitmentMessageTranslationPath(room.recruitmentId, room.chatRoomId, message.message_id),
      sourceVersion: message.translation_source_version,
      source: {
        refetchVersion: () =>
          fetchChatMessageSourceVersion(room.roomId, message.message_id, nextMessageIds.get(message.message_id)),
      },
    };
  };

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
      translation: getTranslation(message),
    })),
  }));
}
