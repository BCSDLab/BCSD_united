import { useCallback, useEffect, useRef } from 'react';
import { captureError } from '@koin/telemetry/runtime';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { postLeaveLostItemChatroomV2 } from 'api/articles';
import { articleQueries, articleQueryKeys } from 'api/articles/queries';
import { sendChatMessage } from 'api/chat';
import { chatQueries, chatQueryKeys } from 'api/chat/queries';
import { isKoinError } from 'interfaces/APIError';
import { getCachedMessages, cacheMessages, clearChatroomCache } from 'utils/db/chatDB';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import showToast from 'utils/ts/showToast';

const POLLING_INTERVAL_MS = 10_000;

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

  const { data: rooms } = useQuery({
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

  const defaultChatroomId = matchedRoom?.chat_room_id ?? null;
  const defaultArticleId = matchedRoom?.context_id ?? null;

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
    if (numericArticleId == null || numericChatroomId == null) return;

    const queryKey = articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn);
    const existing = queryClient.getQueryData(queryKey);
    if (existing) return;

    getCachedMessages(numericArticleId, numericChatroomId).then((cached) => {
      if (cached && cached.length > 0) {
        queryClient.setQueryData(queryKey, cached);
      }
    });
  }, [queryClient, numericArticleId, numericChatroomId, defaultArticleId, defaultChatroomId, isLoggedIn]);

  const { data: roomDetail } = useQuery({
    ...chatQueries.room(userId, matchedRoom?.room_id ?? ''),
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

  const { data: messages } = useQuery({
    ...(defaultArticleId && defaultChatroomId && isOnline
      ? articleQueries.lostItemChatroomMessages(isLoggedIn, Number(defaultArticleId), Number(defaultChatroomId))
      : {
          queryKey: articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn),
          queryFn: skipToken,
        }),
    refetchInterval: isOnline && defaultArticleId && defaultChatroomId ? POLLING_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  // 폴링 응답 도착 시 indexedDB 캐시
  useEffect(() => {
    if (messages && messages.length > 0 && numericArticleId != null && numericChatroomId != null) {
      cacheMessages(numericArticleId, numericChatroomId, messages);
    }
  }, [messages, numericArticleId, numericChatroomId]);

  const { mutate: sendMessage, mutateAsync: sendMessageAsync } = useMutation({
    mutationFn: ({ content, isImage = false }: { content: string; isImage?: boolean }) => {
      if (!matchedRoom) {
        return Promise.reject(new Error('채팅방 정보가 없습니다.'));
      }

      return sendChatMessage(matchedRoom.room_id, {
        content,
        is_image: isImage,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn),
      });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.roomsRoot(userId) });
    },
    onError: (error) => {
      if (isKoinError(error)) {
        showToast('error', error.message || '메시지 전송을 실패하였습니다');
      } else {
        showToast('error', '메시지 전송을 실패하였습니다');
        captureError(error);
      }
    },
  });

  const { mutateAsync: leaveChatroom } = useMutation({
    mutationFn: () => {
      if (defaultArticleId == null || defaultChatroomId == null) {
        return Promise.reject(new Error('채팅방 정보가 없습니다.'));
      }

      return postLeaveLostItemChatroomV2(Number(defaultArticleId), Number(defaultChatroomId));
    },
    onSuccess: () => {
      if (numericArticleId != null && numericChatroomId != null) {
        clearChatroomCache(numericArticleId, numericChatroomId);
      }
      queryClient.invalidateQueries({
        queryKey: articleQueryKeys.lostItemChatroomList(isLoggedIn),
      });
    },
    onError: (error) => {
      if (isKoinError(error)) {
        showToast('error', error.message || '채팅방 퇴장을 실패하였습니다');
      } else {
        showToast('error', '채팅방 퇴장을 실패하였습니다');
        captureError(error);
      }
    },
  });

  const leaveRoom = useCallback((aId: number, cId: number) => {
    postLeaveLostItemChatroomV2(aId, cId).catch((error: unknown) => {
      if (isKoinError(error)) {
        showToast('error', error.message || '채팅방 퇴장을 실패하였습니다');
      } else {
        showToast('error', '채팅방 퇴장을 실패하였습니다');
        captureError(error);
      }
    });
  }, []);

  const prevRoomRef = useRef<{ articleId: number; chatroomId: number } | null>(null);

  useEffect(() => {
    if (numericArticleId != null && numericChatroomId != null) {
      if (
        prevRoomRef.current &&
        (prevRoomRef.current.articleId !== numericArticleId || prevRoomRef.current.chatroomId !== numericChatroomId)
      ) {
        leaveRoom(prevRoomRef.current.articleId, prevRoomRef.current.chatroomId);
      }
      prevRoomRef.current = { articleId: numericArticleId, chatroomId: numericChatroomId };
    }

    return () => {
      if (prevRoomRef.current) {
        leaveRoom(prevRoomRef.current.articleId, prevRoomRef.current.chatroomId);
        prevRoomRef.current = null;
      }
    };
  }, [numericArticleId, numericChatroomId, leaveRoom]);

  const invalidateChatroomList = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: articleQueryKeys.lostItemChatroomList(isLoggedIn),
    });
  }, [queryClient, isLoggedIn]);

  const invalidateMessages = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: articleQueryKeys.lostItemChatroomMessages(defaultArticleId, defaultChatroomId, isLoggedIn),
    });
  }, [queryClient, defaultArticleId, defaultChatroomId, isLoggedIn]);

  return {
    chatroomList,
    chatroomDetail,
    messages,
    defaultChatroomId,
    defaultArticleId,
    sendMessage,
    sendMessageAsync,
    leaveChatroom,
    invalidateChatroomList,
    invalidateMessages,
  };
};

export default useChatPolling;
