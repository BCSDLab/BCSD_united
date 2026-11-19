import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { captureError } from '@koin/telemetry/runtime';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { articleQueryKeys } from 'api/articles/queries';
import { leaveChatPresence, touchChatPresence } from 'api/chat';
import type { ChatMessageCache } from 'api/chat/cache';
import { chatMutations } from 'api/chat/mutations';
import { chatQueries, chatQueryKeys } from 'api/chat/queries';
import { isKoinError } from 'interfaces/APIError';
import { getCachedMessages, cacheMessages, type CachedChatMessage } from 'utils/db/chatDB';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import { getErrorStatus } from 'utils/ts/httpError';
import { parseQueryId } from 'utils/ts/parseServerSideParams';
import showToast from 'utils/ts/showToast';

const POLLING_INTERVAL_MS = 10_000;
const PRESENCE_INTERVAL_MS = 10_000;

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);

  return () => document.removeEventListener('visibilitychange', onChange);
}

const isVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';
const getServerVisibility = () => false;

function reportPresenceError(error: unknown, fallbackMessage: string) {
  if (isKoinError(error)) {
    showToast('error', error.message || fallbackMessage);
  } else {
    showToast('error', fallbackMessage);
    captureError(error);
  }
}

interface UseChatPollingOptions {
  userId: number | null;
  articleId: number | string | null;
  chatroomId: number | string | null;
  isOnline?: boolean;
  autoSelectFirst?: boolean;
}

const useChatPolling = ({
  userId,
  articleId,
  chatroomId,
  isOnline = true,
  autoSelectFirst = true,
}: UseChatPollingOptions) => {
  const isLoggedIn = useIsLoggedIn();
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeToVisibility, isVisible, getServerVisibility);
  const presenceRequestRef = useRef<Promise<unknown>>(Promise.resolve());
  const presenceStateRef = useRef({
    userId,
    roomId: '',
    stopped: false,
    hasReportedError: false,
  });

  const { data: rooms, isPending: isRoomsPending } = useQuery({
    ...chatQueries.rooms(userId, 'LOST_ITEM'),
    enabled: userId !== null && isOnline,
    staleTime: isOnline ? 0 : Infinity,
    refetchInterval: isOnline ? POLLING_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const findMatchedRoom = () => {
    if (chatroomId != null) {
      const matches = rooms?.filter(
        (room) =>
          room.chat_room_id === Number(chatroomId) && (articleId == null || room.context_id === Number(articleId)),
      );

      // 방 번호는 게시글마다 중복될 수 있다. 게시글 ID가 없는 링크는 일치하는 방이 하나일 때만 연다.
      return matches?.length === 1 ? matches[0] : undefined;
    }
    if (articleId == null && autoSelectFirst) return rooms?.[0];

    return undefined;
  };

  const matchedRoom = findMatchedRoom();
  const roomId = matchedRoom?.room_id ?? '';

  const offlineArticleId = !isOnline && articleId != null ? parseQueryId(String(articleId)) : null;
  const offlineChatroomId = !isOnline && chatroomId != null ? parseQueryId(String(chatroomId)) : null;
  const hasOfflineRoom = offlineArticleId !== null && offlineChatroomId !== null;

  // 오프라인에서는 두 ID가 모두 있는 URL로 저장된 대화를 찾고, 서버 room_id는 만들지 않는다.
  const defaultChatroomId = matchedRoom?.chat_room_id ?? (hasOfflineRoom ? offlineChatroomId : null);
  const defaultArticleId = matchedRoom?.context_id ?? (hasOfflineRoom ? offlineArticleId : null);

  // 조회 전환을 독립적으로 적용하기 위해 화면이 사용하던 필드 이름을 여기서 유지한다.
  const chatroomList = rooms?.map((room) => ({
    article_id: room.context_id,
    chat_room_id: room.chat_room_id,
    article_title: room.room_name,
    lost_item_image_url: room.image_url ?? '',
    recent_message_content: room.last_message_is_image ? '사진을 보냈습니다.' : (room.last_message_content ?? ''),
    unread_message_count: room.unread_message_count,
    last_message_at: room.last_message_at ?? '',
  }));

  const numericArticleId = defaultArticleId != null ? Number(defaultArticleId) : null;
  const numericChatroomId = defaultChatroomId != null ? Number(defaultChatroomId) : null;

  // indexedDB 진입
  useEffect(() => {
    if (userId === null || numericArticleId == null || numericChatroomId == null) return;

    const queryKey = articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn);
    const existing = queryClient.getQueryData(queryKey);
    if (existing) return;

    getCachedMessages(numericArticleId, numericChatroomId).then((cached) => {
      if (cached && cached.length > 0) {
        queryClient.setQueryData(queryKey, cached);
      }
    });
  }, [queryClient, userId, numericArticleId, numericChatroomId, defaultArticleId, defaultChatroomId, isLoggedIn]);

  const { data: roomDetail, isPending: isRoomPending } = useQuery({
    ...chatQueries.room(userId, roomId),
    enabled: userId !== null && !!matchedRoom && isOnline,
  });
  const chatroomDetail = roomDetail
    ? {
        article_id: roomDetail.context_id,
        chat_room_id: roomDetail.chat_room_id,
        article_title: roomDetail.room_name,
        chat_partner_profile_image: roomDetail.counterpart_profile_image ?? undefined,
      }
    : undefined;

  const { data: offlineMessages } = useQuery<CachedChatMessage[]>({
    queryKey: articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn),
    queryFn: skipToken,
  });
  const { data: messageCache, isPending: isMessagesPending } = useQuery({
    ...chatQueries.messages(queryClient, userId, roomId),
    enabled: userId !== null && !!roomId && isOnline,
    refetchInterval: isOnline && roomId ? POLLING_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  const messages = messageCache?.messages ?? offlineMessages;
  const isLoadingChat =
    userId !== null &&
    isOnline &&
    (isRoomsPending || (!!matchedRoom && (isRoomPending || (isMessagesPending && !messages))));
  const { mutateAsync: loadPreviousMessages, isPending: isLoadingPreviousMessages } = useMutation(
    chatMutations.loadPreviousMessages(queryClient, userId, roomId),
  );

  const getCachedOldestMessageId = useCallback(
    () => queryClient.getQueryData<ChatMessageCache>(chatQueryKeys.messages(userId, roomId))?.messages[0]?.message_id,
    [queryClient, userId, roomId],
  );

  const { mutate: markRead } = useMutation(chatMutations.markRead(queryClient, userId, roomId));
  const markVisibleMessagesRead = useCallback(
    (messageId: string) => {
      if (isOnline && roomDetail?.supports_read_receipts) markRead(messageId);
    },
    [isOnline, roomDetail?.supports_read_receipts, markRead],
  );

  // 폴링 응답 도착 시 indexedDB 캐시
  useEffect(() => {
    if (messages && messages.length > 0 && numericArticleId != null && numericChatroomId != null) {
      cacheMessages(numericArticleId, numericChatroomId, messages);
    }
  }, [messages, numericArticleId, numericChatroomId]);

  const { mutate: sendMessage, mutateAsync: sendMessageAsync } = useMutation(
    chatMutations.sendMessage(queryClient, userId, roomId),
  );

  // 진행 중인 갱신 뒤에 해제 요청을 보내야 늦은 갱신이 접속 상태를 되살리지 않는다.
  const leaveRoom = useCallback((targetRoomId: string) => {
    const request = presenceRequestRef.current.then(() => leaveChatPresence(targetRoomId));
    presenceRequestRef.current = request.catch(() => undefined);

    return request;
  }, []);

  useEffect(() => {
    if (presenceStateRef.current.userId !== userId || presenceStateRef.current.roomId !== roomId) {
      presenceStateRef.current = { userId, roomId, stopped: false, hasReportedError: false };
    }

    // 탭 숨김이나 네트워크 전환만으로 재시도 중단 상태를 초기화하지 않는다.
    const presenceState = presenceStateRef.current;
    if (userId === null || !roomId || !isOnline || !visible || presenceState.stopped) return;

    let active = true;
    let refreshing = false;

    const handlePresenceError = (error: unknown, fallbackMessage: string) => {
      const status = getErrorStatus(error);
      if (status === 403 || status === 404) {
        presenceState.stopped = true;
        window.clearInterval(interval);
      }
      if (presenceState.hasReportedError) return;

      presenceState.hasReportedError = true;
      reportPresenceError(error, fallbackMessage);
    };

    const refreshPresence = () => {
      if (refreshing || presenceState.stopped) return;
      refreshing = true;
      presenceRequestRef.current = presenceRequestRef.current
        .then(async () => {
          if (!active || !isVisible() || presenceState.stopped) return;

          await touchChatPresence(roomId);
          presenceState.hasReportedError = false;
        })
        .catch((error: unknown) => {
          handlePresenceError(error, '알 수 없는 오류가 발생했습니다.');
        })
        .finally(() => {
          refreshing = false;
        });
    };

    const interval = window.setInterval(refreshPresence, PRESENCE_INTERVAL_MS);
    refreshPresence();

    return () => {
      active = false;
      window.clearInterval(interval);
      void leaveRoom(roomId).catch((error: unknown) => {
        handlePresenceError(error, '채팅방 퇴장을 실패하였습니다');
      });
    };
  }, [userId, roomId, isOnline, visible, leaveRoom]);

  return {
    chatroomList,
    chatroomDetail,
    messages,
    isLoadingChat,
    hasPreviousMessages: messageCache?.hasPreviousMessages ?? false,
    isLoadingPreviousMessages,
    loadPreviousMessages,
    getCachedOldestMessageId,
    defaultChatroomId,
    defaultArticleId,
    sendMessage,
    sendMessageAsync,
    markVisibleMessagesRead,
  };
};

export default useChatPolling;
