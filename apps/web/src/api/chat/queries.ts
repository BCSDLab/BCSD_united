import { queryOptions, replaceEqualDeep, type QueryClient } from '@tanstack/react-query';

import { CHAT_MESSAGE_LIMIT, fetchChatMessageCache, mergeChatMessageCache, type ChatMessageCache } from './cache';
import type { ChatDomainType } from './entity';
import { getChatMessages, getChatRoom, getChatRooms } from './index';

export const chatQueryKeys = {
  all: ['chat'] as const,
  viewer: (userId: number | null) => ['chat', userId] as const,
  roomsRoot: (userId: number | null) => [...chatQueryKeys.viewer(userId), 'rooms'] as const,
  rooms: (userId: number | null, domainType?: ChatDomainType) =>
    [...chatQueryKeys.roomsRoot(userId), domainType ?? 'ALL'] as const,
  roomRoot: (userId: number | null, roomId: string) => [...chatQueryKeys.viewer(userId), 'room', roomId] as const,
  room: (userId: number | null, roomId: string) => [...chatQueryKeys.roomRoot(userId, roomId), 'detail'] as const,
  messages: (userId: number | null, roomId: string) => [...chatQueryKeys.roomRoot(userId, roomId), 'messages'] as const,
  previousMessages: (userId: number | null, roomId: string, beforeId: string) =>
    [...chatQueryKeys.roomRoot(userId, roomId), 'history', beforeId] as const,
};

export const chatQueries = {
  rooms: (userId: number | null, domainType?: ChatDomainType) =>
    queryOptions({
      queryKey: chatQueryKeys.rooms(userId, domainType),
      queryFn: ({ signal }) => getChatRooms({ domain_type: domainType }, signal),
      enabled: userId !== null,
      staleTime: 0,
      refetchIntervalInBackground: false,
    }),

  room: (userId: number | null, roomId: string) =>
    queryOptions({
      queryKey: chatQueryKeys.room(userId, roomId),
      queryFn: ({ signal }) => getChatRoom(roomId, signal),
      enabled: userId !== null && !!roomId,
      staleTime: 0,
      refetchIntervalInBackground: false,
    }),

  messages: (queryClient: QueryClient, userId: number | null, roomId: string) =>
    queryOptions({
      queryKey: chatQueryKeys.messages(userId, roomId),
      queryFn: ({ signal }) =>
        fetchChatMessageCache(
          queryClient.getQueryData<ChatMessageCache>(chatQueryKeys.messages(userId, roomId)),
          async (params) => {
            signal.throwIfAborted();
            const messages = await getChatMessages(roomId, params, signal);
            signal.throwIfAborted();

            return messages;
          },
        ),
      enabled: userId !== null && !!roomId,
      staleTime: 0,
      // 빈 방을 조회한 상태와 복구 기준은 방을 나갔다 돌아와도 유지하고, 로그아웃 시 기존 clear로 비운다.
      gcTime: Infinity,
      refetchIntervalInBackground: false,
      structuralSharing: (previous, next) =>
        replaceEqualDeep(
          previous,
          mergeChatMessageCache(previous as ChatMessageCache | undefined, next as ChatMessageCache),
        ),
    }),

  previousMessages: (userId: number | null, roomId: string, beforeId: string) =>
    queryOptions({
      queryKey: chatQueryKeys.previousMessages(userId, roomId, beforeId),
      queryFn: ({ signal }) =>
        getChatMessages(roomId, { before_message_id: beforeId, limit: CHAT_MESSAGE_LIMIT }, signal),
      enabled: false,
      staleTime: 0,
    }),
};
