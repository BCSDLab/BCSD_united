import type { APIResponse } from 'interfaces/APIResponse';

export type ChatDomainType = 'LOST_ITEM' | 'CALLVAN' | 'TEAM_RECRUITMENT';

export type ChatRoomType = 'DIRECT' | 'GROUP';

export interface ChatRoomListRequest {
  domain_type?: ChatDomainType;
}

export interface ChatRoomResponse extends APIResponse {
  room_id: string;
  domain_type: ChatDomainType;
  context_id: number;
  chat_room_id: number;
  room_type: ChatRoomType;
  can_send: boolean;
  supports_read_receipts: boolean;
  room_name: string;
  image_url: string | null;
  member_count: number | null;
  max_member_count: number | null;
  counterpart_id: number | null;
  counterpart_nickname: string | null;
  counterpart_profile_image: string | null;
  unread_message_count: number;
  last_message_id: string | null;
  last_message_is_image: boolean | null;
  last_message_content: string | null;
  last_message_at: string | null;
}

export type ChatRoomListResponse = ChatRoomResponse[];

export interface ChatMessageResponse extends APIResponse {
  message_id: string;
  user_id: number | null;
  user_nickname: string | null;
  content: string;
  timestamp: string;
  is_image: boolean;
  unread_count: number;
  is_left_user: boolean;
}

export type ChatMessageListResponse = ChatMessageResponse[];

// 이전 대화와 새 메시지 조회 기준은 한 요청에 함께 보낼 수 없다.
export type ChatMessageListRequest = { limit?: number } & (
  | { after_message_id?: string; before_message_id?: never }
  | { after_message_id?: never; before_message_id?: string }
);

export interface ChatMessageSendRequest {
  content: string;
  is_image: boolean;
}

export interface ChatReadRequest {
  message_id: string;
}
