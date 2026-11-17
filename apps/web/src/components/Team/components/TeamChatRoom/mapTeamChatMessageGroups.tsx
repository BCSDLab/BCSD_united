import { teamChatMessageTranslationPath } from 'api/team/APIDetail';
import type { TeamChatMessage } from 'api/team/entity';
import groupChatMessagesByDate from 'components/Team/utils/groupChatMessagesByDate';
import type { ChatMessageListGroup, ChatMessageTranslation } from 'components/ui/Chat';
import { formatChatTime } from 'utils/ts/chatTime';

import TeamChatSenderAvatar from './TeamChatSenderAvatar';

export default function mapTeamChatMessageGroups(
  messages: TeamChatMessage[],
  currentUserId: number | undefined,
  room: {
    recruitmentId: number;
    chatRoomId: number;
    /** 원문 버전이 바뀌었을 때(409) 해당 메시지를 다시 받아 새 버전을 돌려준다 */
    refetchMessageVersion: (messageId: number) => Promise<string | null | undefined>;
  },
): ChatMessageListGroup[] {
  // 상대가 보낸 텍스트 쪽지만 번역한다
  const getTranslation = (message: TeamChatMessage): ChatMessageTranslation | undefined => {
    // 내 정보를 받기 전에는 내 메시지인지 알 수 없으므로 붙이지 않는다
    if (currentUserId === undefined || message.user_id === currentUserId || message.is_image) return undefined;

    return {
      resourceType: 'RECRUITMENT_MESSAGE',
      resourceId: message.message_id,
      parentId: room.recruitmentId,
      roomId: room.chatRoomId,
      translatePath: teamChatMessageTranslationPath(room.recruitmentId, room.chatRoomId, message.message_id),
      sourceVersion: message.translation_source_version,
      refetchSourceVersion: () => room.refetchMessageVersion(message.message_id),
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
      senderName: message.user_nickname,
      senderAvatar: <TeamChatSenderAvatar />,
      translation: getTranslation(message),
    })),
  }));
}
