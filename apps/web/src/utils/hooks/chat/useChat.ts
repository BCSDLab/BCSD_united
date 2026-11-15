import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ChatMessageResponse, ChatMessageSendRequest } from 'api/chat/entity';
import { chatMutations } from 'api/chat/mutations';
import { chatQueries, chatQueryKeys } from 'api/chat/queries';

const EMPTY_MESSAGES: ChatMessageResponse[] = [];

interface UseChatOptions {
  userId: number | null;
  roomId: string | null;
  pollingInterval?: number;
  isOnline?: boolean;
}

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);

  return () => document.removeEventListener('visibilitychange', onChange);
}

const isVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
const getServerVisibility = () => false;

export default function useChat({ userId, roomId, pollingInterval = 1000, isOnline = true }: UseChatOptions) {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeToVisibility, isVisible, getServerVisibility);
  const active = userId !== null && !!roomId && isOnline && visible;
  const currentRoomId = roomId ?? '';
  const activeRoomRef = useRef<{ userId: number | null; roomId: string } | null>(null);
  const roomQuery = useQuery({
    ...chatQueries.room(userId, currentRoomId),
    enabled: active,
    refetchInterval: active ? pollingInterval : false,
  });
  const messagesQuery = useQuery({
    ...chatQueries.messages(queryClient, userId, currentRoomId),
    enabled: active,
    refetchInterval: active ? pollingInterval : false,
  });
  const { mutateAsync: sendMessageAsync, isPending: isSending } = useMutation(
    chatMutations.sendMessage(queryClient, userId, currentRoomId),
  );
  const { mutateAsync: markReadAsync } = useMutation(chatMutations.markRead(queryClient, userId, currentRoomId));
  const { mutateAsync: loadPreviousAsync, isPending: isLoadingPreviousMessages } = useMutation(
    chatMutations.loadPreviousMessages(queryClient, userId, currentRoomId),
  );

  useEffect(() => {
    const queryKey = chatQueryKeys.roomRoot(userId, currentRoomId);
    activeRoomRef.current = active ? { userId, roomId: currentRoomId } : null;
    if (!active) void queryClient.cancelQueries({ queryKey });

    return () => {
      activeRoomRef.current = null;
      const query = queryClient.getQueryCache().find({
        queryKey: chatQueryKeys.messages(userId, currentRoomId),
        exact: true,
      });
      if (!query || query.getObserversCount() <= 1) void queryClient.cancelQueries({ queryKey });
    };
  }, [active, queryClient, userId, currentRoomId]);

  const isCurrentRoomActive = useCallback(() => {
    const current = activeRoomRef.current;

    return active && isVisible() && current?.userId === userId && current.roomId === currentRoomId;
  }, [active, userId, currentRoomId]);

  const sendMessage = useCallback(
    (data: ChatMessageSendRequest) => {
      if (!isCurrentRoomActive() || !roomQuery.data?.can_send) {
        return Promise.reject(new Error('현재 채팅방에 메시지를 보낼 수 없습니다.'));
      }

      return sendMessageAsync(data);
    },
    [isCurrentRoomActive, roomQuery.data?.can_send, sendMessageAsync],
  );

  // 화면에서 실제로 확인한 메시지 ID를 호출부가 전달한다. 수신만으로 읽음 처리하지 않는다.
  const markVisibleMessagesRead = useCallback(
    (messageId: string) => {
      if (!isCurrentRoomActive() || !roomQuery.data?.supports_read_receipts) return Promise.resolve(false);

      return markReadAsync(messageId);
    },
    [isCurrentRoomActive, roomQuery.data?.supports_read_receipts, markReadAsync],
  );

  const loadPreviousMessages = useCallback(() => {
    if (!isCurrentRoomActive()) return Promise.resolve(null);

    return loadPreviousAsync();
  }, [isCurrentRoomActive, loadPreviousAsync]);

  return {
    room: roomQuery.data,
    messages: messagesQuery.data?.messages ?? EMPTY_MESSAGES,
    hasPreviousMessages: messagesQuery.data?.hasPreviousMessages ?? false,
    isLoading: roomQuery.isLoading || messagesQuery.isLoading,
    error: roomQuery.error ?? messagesQuery.error,
    isSending,
    isLoadingPreviousMessages,
    isActive: active,
    sendMessage,
    markVisibleMessagesRead,
    loadPreviousMessages,
  };
}
