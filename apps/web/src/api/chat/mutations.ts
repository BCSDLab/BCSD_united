import { captureError } from '@koin/telemetry/runtime';
import { isCancelledError, mutationOptions, type QueryClient } from '@tanstack/react-query';

import { authQueries } from 'api/auth/queries';
import { isHttpError, isKoinError } from 'interfaces/APIError';
import showToast from 'utils/ts/showToast';

import {
  CHAT_MESSAGE_LIMIT,
  compareMessageIds,
  createChatMessageCache,
  mergeChatMessageCache,
  mergeChatMessages,
  type ChatMessageCache,
} from './cache';
import type { ChatDomainType, ChatMessageSendRequest, ChatRoomListResponse } from './entity';
import { markChatRead, sendChatMessage } from './index';
import { chatQueries, chatQueryKeys } from './queries';

function requireChatRoom(userId: number | null, roomId: string): void {
  if (userId === null || !roomId) throw new Error('채팅방 정보가 없습니다.');
}

function reportChatError(error: unknown): void {
  if (isCancelledError(error)) return;
  if (isHttpError(error) && error.code === 'ABORTED') return;
  if (isKoinError(error)) {
    showToast('error', error.message);

    return;
  }
  showToast('error', '채팅 요청을 처리하지 못했어요. 다시 시도해 주세요.');
  captureError(error);
}

function invalidateChatRoom(queryClient: QueryClient, userId: number | null, roomId: string): void {
  void queryClient.invalidateQueries({ queryKey: chatQueryKeys.roomsRoot(userId) });
  void queryClient.invalidateQueries({ queryKey: chatQueryKeys.room(userId, roomId), exact: true });
  void queryClient.invalidateQueries({ queryKey: chatQueryKeys.messages(userId, roomId), exact: true });
}

export async function invalidateChatRooms(
  queryClient: QueryClient,
  domainType: ChatDomainType,
  contextId: number,
): Promise<void> {
  const userId = queryClient.getQueryData(authQueries.userInfo(true).queryKey)?.id;
  if (userId === undefined) return;

  const cachedRooms = queryClient
    .getQueriesData<ChatRoomListResponse>({ queryKey: chatQueryKeys.roomsRoot(userId) })
    .flatMap(([, rooms]) => rooms ?? [])
    .filter((room) => room.domain_type === domainType && room.context_id === contextId);
  // room_id는 서버가 반환한 값을 사용하고, 해당 글의 방만 갱신한다.
  const roomIds = new Set(cachedRooms.map((room) => room.room_id));

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms(userId, domainType), exact: true }),
    queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms(userId), exact: true }),
    ...Array.from(roomIds, (roomId) =>
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.roomRoot(userId, roomId) }),
    ),
  ]);
}

export const chatMutations = {
  sendMessage: (queryClient: QueryClient, userId: number | null, roomId: string) => {
    const queryKey = chatQueryKeys.messages(userId, roomId);

    return mutationOptions({
      mutationFn: (data: ChatMessageSendRequest) => {
        requireChatRoom(userId, roomId);

        return sendChatMessage(roomId, data);
      },
      retry: false,
      onMutate: () => ({ query: queryClient.getQueryCache().find({ queryKey, exact: true }) }),
      onSuccess: (message, _data, context) => {
        // 로그아웃으로 clear된 캐시에 늦은 전송 응답이 기록을 다시 만들지 않게 한다.
        if (!context?.query || queryClient.getQueryCache().find({ queryKey, exact: true }) !== context.query) return;
        queryClient.setQueryData<ChatMessageCache>(queryKey, (previous) => {
          const cache = previous ?? createChatMessageCache();

          return { ...cache, messages: mergeChatMessages(cache.messages, [message]) };
        });
        invalidateChatRoom(queryClient, userId, roomId);
      },
      onError: reportChatError,
    });
  },

  markRead: (queryClient: QueryClient, userId: number | null, roomId: string) => {
    const queryKey = chatQueryKeys.messages(userId, roomId);

    return mutationOptions({
      scope: { id: JSON.stringify([...queryKey, 'read']) },
      mutationFn: async (messageId: string) => {
        requireChatRoom(userId, roomId);
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
        const cache = queryClient.getQueryData<ChatMessageCache>(queryKey);
        if (!cache?.messages.some((message) => message.message_id === messageId)) return false;
        // 전송 응답만 먼저 도착했다면 중간 메시지를 확인하기 전까지 읽음 위치도 앞당기지 않는다.
        if (!cache.lastFetchedMessageId || compareMessageIds(messageId, cache.lastFetchedMessageId) > 0) return false;
        if (cache.lastReadMessageId && compareMessageIds(cache.lastReadMessageId, messageId) >= 0) return false;
        await markChatRead(roomId, { message_id: messageId });

        return true;
      },
      retry: false,
      onMutate: () => ({ query: queryClient.getQueryCache().find({ queryKey, exact: true }) }),
      onSuccess: (updated, messageId, context) => {
        if (
          !updated ||
          !context?.query ||
          queryClient.getQueryCache().find({ queryKey, exact: true }) !== context.query
        ) {
          return;
        }
        queryClient.setQueryData<ChatMessageCache>(queryKey, (previous) =>
          previous ? { ...previous, lastReadMessageId: messageId } : previous,
        );
        invalidateChatRoom(queryClient, userId, roomId);
      },
      onError: reportChatError,
    });
  },

  loadPreviousMessages: (queryClient: QueryClient, userId: number | null, roomId: string) => {
    const queryKey = chatQueryKeys.messages(userId, roomId);

    return mutationOptions({
      scope: { id: JSON.stringify([...queryKey, 'history']) },
      mutationFn: async () => {
        requireChatRoom(userId, roomId);
        const cache = queryClient.getQueryData<ChatMessageCache>(queryKey);
        const oldestId = cache?.messages[0]?.message_id;
        if (!oldestId || !cache.hasPreviousMessages) return null;
        const messages = await queryClient.fetchQuery(chatQueries.previousMessages(userId, roomId, oldestId));

        return { messages, beforeId: oldestId };
      },
      retry: false,
      onMutate: () => ({ query: queryClient.getQueryCache().find({ queryKey, exact: true }) }),
      onSuccess: (page, _data, context) => {
        if (!page || !context?.query || queryClient.getQueryCache().find({ queryKey, exact: true }) !== context.query) {
          return;
        }
        queryClient.setQueryData<ChatMessageCache>(queryKey, (previous) => {
          if (!previous) return previous;
          if (!page.messages.length) {
            return previous.messages[0]?.message_id === page.beforeId
              ? { ...previous, hasPreviousMessages: false }
              : previous;
          }

          return mergeChatMessageCache(previous, {
            ...previous,
            messages: page.messages,
            hasPreviousMessages: page.messages.length === CHAT_MESSAGE_LIMIT,
          });
        });
      },
      onError: reportChatError,
    });
  },
};
