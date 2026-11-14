import { type APIRequest, HTTP_METHOD } from 'interfaces/APIRequest';

import type {
  ChatMessageListRequest,
  ChatMessageListResponse,
  ChatMessageResponse,
  ChatMessageSendRequest,
  ChatReadRequest,
  ChatRoomListRequest,
  ChatRoomListResponse,
  ChatRoomResponse,
} from './entity';

// 본문 없는 204 응답을 APIClient의 object 응답 계약에 맞춰 정규화한다.
const parseNoContent = (): Record<string, never> => ({});

export class GetChatRooms implements APIRequest<ChatRoomListResponse> {
  method = HTTP_METHOD.GET;

  path = '/chatrooms';

  response!: ChatRoomListResponse;

  params: Record<string, unknown>;

  constructor(
    params: ChatRoomListRequest = {},
    public signal?: AbortSignal,
  ) {
    this.params = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
  }
}

export class GetChatRoom implements APIRequest<ChatRoomResponse> {
  method = HTTP_METHOD.GET;

  path: string;

  response!: ChatRoomResponse;

  constructor(
    roomId: string,
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}`;
  }
}

export class GetChatMessages implements APIRequest<ChatMessageListResponse> {
  method = HTTP_METHOD.GET;

  path: string;

  response!: ChatMessageListResponse;

  params: Record<string, unknown>;

  constructor(
    roomId: string,
    params: ChatMessageListRequest = {},
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}/messages`;
    this.params = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
  }
}

export class PostChatMessage implements APIRequest<ChatMessageResponse> {
  method = HTTP_METHOD.POST;

  path: string;

  response!: ChatMessageResponse;

  constructor(
    roomId: string,
    public data: ChatMessageSendRequest,
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}/messages`;
  }
}

export class PostChatRead implements APIRequest<Record<string, never>> {
  method = HTTP_METHOD.POST;

  path: string;

  response!: Record<string, never>;

  parse = parseNoContent;

  constructor(
    roomId: string,
    public data: ChatReadRequest,
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}/read`;
  }
}

export class PostChatPresence implements APIRequest<Record<string, never>> {
  method = HTTP_METHOD.POST;

  path: string;

  response!: Record<string, never>;

  parse = parseNoContent;

  constructor(
    roomId: string,
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}/presence`;
  }
}

export class DeleteChatPresence implements APIRequest<Record<string, never>> {
  method = HTTP_METHOD.DELETE;

  path: string;

  response!: Record<string, never>;

  parse = parseNoContent;

  constructor(
    roomId: string,
    public signal?: AbortSignal,
  ) {
    this.path = `/chatrooms/${encodeURIComponent(roomId)}/presence`;
  }
}
