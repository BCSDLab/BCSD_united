import { CHAT_MESSAGE_LIMIT } from './cache';
import { getChatMessages } from './index';

export const lostItemMessageTranslationPath = (articleId: number, chatRoomId: number, messageId: string) =>
  `/v2/chatroom/lost-item/${articleId}/${chatRoomId}/messages/${encodeURIComponent(messageId)}/translations`;

export const teamRecruitmentMessageTranslationPath = (recruitmentId: number, chatRoomId: number, messageId: string) =>
  `/chatroom/team-recruitment/${recruitmentId}/${chatRoomId}/messages/${encodeURIComponent(messageId)}/translations`;

/**
 * 쪽지 하나의 최신 `translation_source_version`을 다시 받는다.
 * 메시지 하나만 조회하는 경로가 없어, 바로 다음 메시지가 있으면 그보다 앞선 메시지 1개를 받는다.
 * 다음 메시지가 없으면 그 사이 새 메시지가 왔을 수 있으므로 최신 메시지 목록에서 찾는다.
 */
export async function fetchChatMessageSourceVersion(roomId: string, messageId: string, nextMessageId?: string) {
  const messages = await getChatMessages(
    roomId,
    nextMessageId ? { before_message_id: nextMessageId, limit: 1 } : { limit: CHAT_MESSAGE_LIMIT },
  );

  return messages.find((message) => message.message_id === messageId)?.translation_source_version;
}
