import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createFileRoute, useNavigate, useSearch, useParams } from '@tanstack/react-router';

import BlockIcon from 'assets/svg/Articles/block.svg';
import DefaultPhotoIcon from 'assets/svg/Articles/default-photo.svg';
import DefaultPhotoUrl from 'assets/svg/Articles/default-photo.svg?url';
import PersonIcon from 'assets/svg/Articles/person.svg';
import { useChatLogger } from 'components/Articles/hooks/useChatLogger';
import ChatHeaderMenu from 'components/Articles/LostItemChatPage/components/ChatHeaderMenu';
import DeleteModal from 'components/Articles/LostItemChatPage/components/DeleteModal';
import useChatPolling from 'components/Articles/LostItemChatPage/hooks/useChatPolling';
import LoadingSpinner from 'components/feedback/LoadingSpinner';
import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import {
  ChatLayout,
  ChatMessageInput,
  ChatMessageList,
  ChatRoomList,
  type ChatMessageListGroup,
} from 'components/ui/Chat';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useNetworkStatus from 'utils/hooks/state/useNetworkStatus';
import { useUser } from 'utils/hooks/state/useUser';
import useImageUpload, { UploadError } from 'utils/hooks/ui/useImageUpload';
import { formatChatDate, formatChatTime, formatChatRoomListTime } from 'utils/ts/chatTime';
import { parseQueryId } from 'utils/ts/parseServerSideParams';
import showToast from 'utils/ts/showToast';

import styles from 'pages/lost-item/chat/LostItemChatPage.module.scss';

interface LostItemChatPageProps {
  articleIdParam: string | null;
  chatRoomIdParam: string | null;
}

interface PreviousMessagesScrollSnapshot {
  roomKey: string;
  oldestMessageId: string | undefined;
  anchorTop: number | undefined;
  scrollTop: number;
}

function findLastVisibleMessageId(container: HTMLDivElement): string | undefined {
  const bounds = container.getBoundingClientRect();
  const visibleTop = Math.max(bounds.top, 0);
  const visibleBottom = Math.min(bounds.bottom, window.innerHeight);
  if (bounds.width === 0 || visibleTop >= visibleBottom) return undefined;

  const messageElements = container.querySelectorAll<HTMLElement>('[data-message-id]');
  for (let index = messageElements.length - 1; index >= 0; index -= 1) {
    const element = messageElements[index];
    const messageBounds = element.getBoundingClientRect();
    if (messageBounds.bottom > visibleTop && messageBounds.top < visibleBottom) {
      return element.dataset.messageId;
    }
  }

  return undefined;
}

function LostItemChatPage({ articleIdParam, chatRoomIdParam }: LostItemChatPageProps) {
  const isMobile = useMediaQuery();
  const isOnline = useNetworkStatus();
  const { data: userInfo } = useUser();
  const userId = userInfo?.id ?? null;

  const { imgRef, saveImgFile } = useImageUpload({ domain: 'LOST_ITEMS' });

  const [inputValue, setInputValue] = useState('');
  const [isDeleteModalOpen, openDeleteModal, closeDeleteModal] = useBooleanState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const { logMessageListSelcetClick } = useChatLogger();

  const requestedDetail = !isMobile || !!chatRoomIdParam;

  const {
    chatroomDetail,
    chatroomList,
    messages,
    isLoadingChat,
    hasPreviousMessages,
    isLoadingPreviousMessages,
    loadPreviousMessages,
    getCachedOldestMessageId,
    defaultChatroomId: chatroomId,
    defaultArticleId: articleId,
    sendMessage: sendChatMessage,
    sendMessageAsync: sendChatMessageAsync,
    markVisibleMessagesRead,
  } = useChatPolling({
    userId,
    articleId: articleIdParam,
    chatroomId: chatRoomIdParam,
    isOnline,
    autoSelectFirst: requestedDetail,
  });
  const showDetail = !isMobile || (requestedDetail && (isLoadingChat || (articleId !== null && chatroomId !== null)));
  const showList = !isMobile || !showDetail;
  const isChatroomOpen = showDetail && !!chatroomDetail;

  const prevMessagesLengthRef = useRef(0);
  const previousRoomKeyRef = useRef<string | null>(null);
  const roomKey = `${userId}:${articleId}:${chatroomId}`;
  const previousMessagesScrollRef = useRef<PreviousMessagesScrollSnapshot | null>(null);

  useLayoutEffect(() => {
    return () => {
      // 방이나 사용자가 바뀐 뒤에는 이전 요청의 완료 처리가 현재 화면에 적용되지 않는다.
      previousMessagesScrollRef.current = null;
    };
  }, [roomKey]);

  const loadPreviousMessagesOnScroll = async (event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    if (
      container.scrollTop > 0 ||
      !isOnline ||
      !hasPreviousMessages ||
      isLoadingPreviousMessages ||
      previousMessagesScrollRef.current
    ) {
      return;
    }

    const scrollSnapshot = {
      roomKey,
      oldestMessageId: messages?.[0]?.message_id,
      anchorTop: container.querySelector<HTMLElement>('[data-message-id]')?.getBoundingClientRect().top,
      scrollTop: container.scrollTop,
    };
    previousMessagesScrollRef.current = scrollSnapshot;

    try {
      await loadPreviousMessages();
    } catch {
      // 조회 오류는 공통 mutation에서 표시하고, 다음 스크롤에서 다시 시도할 수 있게 한다.
    } finally {
      // 앞쪽 메시지가 캐시에 추가됐으면 다음 렌더의 layout effect가 위치를 보정하고 스냅샷을 해제한다.
      // 캐시가 없거나 앞쪽 메시지가 추가되지 않았으면 보정할 대상이 없으므로 여기서 해제한다.
      if (previousMessagesScrollRef.current === scrollSnapshot) {
        const cachedOldestId = getCachedOldestMessageId();
        if (cachedOldestId === undefined || cachedOldestId === scrollSnapshot.oldestMessageId) {
          previousMessagesScrollRef.current = null;
        }
      }
    }
  };

  const uploadImage = async () => {
    try {
      if (userInfo === null || !chatroomDetail) {
        showToast('error', '유저정보 혹은 채팅방 정보를 불러오는데 실패했습니다.');

        return;
      }

      const imageUrlList = await saveImgFile();
      for (const imageUrl of imageUrlList) {
        try {
          await sendChatMessageAsync({ content: imageUrl, is_image: true });
        } catch {
          continue;
        }
      }
    } catch (error) {
      if (error instanceof UploadError) {
        showToast('error', error.message);
      }
    }
  };

  const sendMessage = () => {
    if (!inputValue.trim() || userInfo === null || !chatroomDetail) {
      return false;
    }

    sendChatMessage({ content: inputValue, is_image: false });
    setInputValue('');

    return true;
  };

  const addErrorImage = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    e.currentTarget.src = DefaultPhotoUrl;
  };

  useLayoutEffect(() => {
    const currentLength = messages?.length ?? 0;
    const hasNewMessages = currentLength > prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = currentLength;
    const container = chatContainerRef.current;
    if (!container) {
      previousMessagesScrollRef.current = null;

      return;
    }
    const hasRoomChanged = previousRoomKeyRef.current !== roomKey;
    previousRoomKeyRef.current = roomKey;

    const scrollSnapshot = previousMessagesScrollRef.current;
    if (scrollSnapshot?.roomKey === roomKey) {
      if (messages?.[0]?.message_id !== scrollSnapshot.oldestMessageId) {
        const anchor = container.querySelector<HTMLElement>(`[data-message-id="${scrollSnapshot.oldestMessageId}"]`);
        if (anchor && scrollSnapshot.anchorTop !== undefined) {
          // 뒤에 새 메시지가 추가돼도 기존 메시지의 위치를 기준으로 보정한다.
          container.scrollTop =
            scrollSnapshot.scrollTop + anchor.getBoundingClientRect().top - scrollSnapshot.anchorTop;
        }
        previousMessagesScrollRef.current = null;
      }

      return;
    }
    previousMessagesScrollRef.current = null;

    if (hasNewMessages || hasRoomChanged) container.scrollTop = container.scrollHeight;
  }, [messages, roomKey, isChatroomOpen]);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!showDetail || !container) return;
    let animationFrame: number | undefined;

    const markVisibleMessages = () => {
      animationFrame = undefined;
      if (document.visibilityState !== 'visible') return;
      const lastVisibleMessageId = findLastVisibleMessageId(container);
      if (lastVisibleMessageId) markVisibleMessagesRead(lastVisibleMessageId);
    };
    const scheduleRead = () => {
      if (animationFrame === undefined) animationFrame = window.requestAnimationFrame(markVisibleMessages);
    };

    scheduleRead();
    container.addEventListener('scroll', scheduleRead);
    container.addEventListener('load', scheduleRead, true);
    document.addEventListener('visibilitychange', scheduleRead);
    window.addEventListener('resize', scheduleRead);

    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      container.removeEventListener('scroll', scheduleRead);
      container.removeEventListener('load', scheduleRead, true);
      document.removeEventListener('visibilitychange', scheduleRead);
      window.removeEventListener('resize', scheduleRead);
    };
  }, [showDetail, messages, markVisibleMessagesRead]);

  const chatRoomItems = (chatroomList ?? []).map(
    ({
      article_id,
      chat_room_id,
      article_title,
      last_message_at,
      lost_item_image_url,
      recent_message_content,
      unread_message_count,
    }) => ({
      key: `${chat_room_id}-${article_id}`,
      href: ROUTES.LostItemChat({ articleId: String(article_id), chatRoomId: String(chat_room_id) }),
      title: article_title,
      timeLabel: formatChatRoomListTime(last_message_at),
      preview: recent_message_content,
      unreadCount: unread_message_count,
      avatar: lost_item_image_url ? (
        <img
          src={lost_item_image_url}
          alt="분실물 이미지"
          className={styles['chat-list--item-image']}
          onError={addErrorImage}
        />
      ) : (
        <DefaultPhotoIcon />
      ),
      isActive: article_id === Number(articleId) && chat_room_id === Number(chatroomId),
      onClick: logMessageListSelcetClick,
    }),
  );

  const messageGroups = (messages ?? []).reduce<ChatMessageListGroup[]>((groups, message, index) => {
    const dateLabel = formatChatDate(message.timestamp);
    const timeLabel = formatChatTime(message.timestamp);
    const normalizedMessage = {
      key: message.message_id ?? `${message.timestamp}-${index}`,
      messageId: message.message_id,
      isMine: message.user_id === userInfo?.id,
      content: message.content,
      isImage: message.is_image,
      timeLabel,
      senderId: message.user_id,
      senderName: message.user_nickname || '익명',
      senderAvatar: (
        <div className={styles['message-item--profile']}>
          <PersonIcon />
        </div>
      ),
    };
    const lastGroup = groups[groups.length - 1];

    if (lastGroup?.dateLabel === dateLabel) {
      lastGroup.messages.push(normalizedMessage);

      return groups;
    }

    groups.push({
      key: `${dateLabel}-${index}`,
      dateLabel,
      messages: [normalizedMessage],
    });

    return groups;
  }, []);

  return (
    <>
      <MobilePageHeader
        title={isChatroomOpen ? chatroomDetail.article_title : '쪽지'}
        rightAction={isChatroomOpen ? <ChatHeaderMenu onBlockClick={openDeleteModal} /> : undefined}
      />
      <div className={styles.container}>
        {!isMobile && <h1 className={styles.title}>쪽지</h1>}

        <ChatLayout
          className={styles['chat-container']}
          sidebarClassName={styles['chat-list']}
          panelClassName={styles['chat-view']}
          sidebar={showList && <ChatRoomList items={chatRoomItems} />}
        >
          {showDetail && (
            <>
              {isLoadingChat && (
                <div className={styles.chat__empty} role="status" aria-label="채팅방을 불러오는 중입니다.">
                  <LoadingSpinner size="50px" />
                </div>
              )}
              {!isLoadingChat && !(chatroomDetail && messages) && (
                <div className={styles.chat__empty}>
                  선택된 채팅방이 없습니다.
                  <br />
                  왼쪽 리스트에서 채팅방을 선택해주세요.🙇‍♂️
                </div>
              )}
              {!isLoadingChat && chatroomDetail && messages && (
                <>
                  <div className={styles['chat-view--header']}>
                    <div>
                      {chatroomDetail.chat_partner_profile_image ? (
                        <img
                          src={chatroomDetail.chat_partner_profile_image}
                          alt="분실물 이미지"
                          className={styles['chat-list--item-profile']}
                          onError={addErrorImage}
                        />
                      ) : (
                        <div className={styles['chat-list--item-profile']}>
                          <DefaultPhotoIcon />
                        </div>
                      )}
                      <div className={styles['chat-view--title']}>{chatroomDetail.article_title}</div>
                    </div>
                    <button type="button" className={styles['chat-block']} onClick={openDeleteModal}>
                      <BlockIcon />
                      <div>차단하기</div>
                    </button>
                  </div>

                  <div
                    className={styles['message-container']}
                    ref={chatContainerRef}
                    onScroll={(event) => {
                      void loadPreviousMessagesOnScroll(event);
                    }}
                  >
                    <ChatMessageList groups={messageGroups} />
                  </div>
                  <div className={styles['chat-input-container-wrapper']}>
                    {!isOnline && (
                      <div className={styles['offline-banner']}>
                        오프라인 상태입니다. 저장된 메시지만 볼 수 있습니다.
                      </div>
                    )}
                    <ChatMessageInput
                      classNames={{
                        container: styles['chat-input-container'],
                        imageControl: styles['image-button'],
                        textarea: styles['chat-input'],
                        sendButton: styles['send-button'],
                      }}
                      value={inputValue}
                      onChange={setInputValue}
                      onSend={sendMessage}
                      onImageChange={() => {
                        void uploadImage();
                      }}
                      disabled={!isOnline}
                      placeholder={isOnline ? undefined : '오프라인 상태입니다'}
                      fileInputRef={imgRef}
                      imageInputMultiple
                    />
                  </div>
                </>
              )}
            </>
          )}
        </ChatLayout>

        {isDeleteModalOpen && (
          <DeleteModal
            articleId={Number(articleId)}
            chatroomId={Number(chatroomId)}
            closeDeleteModal={closeDeleteModal}
          />
        )}
      </div>
    </>
  );
}

function LostItemChatPageWrapper() {
  const isLoggedIn = useIsLoggedIn();
  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const articleId = routeQuery.articleId;
  const chatRoomId = routeQuery.chatRoomId ?? routeQuery.chatroomId;
  const isList = articleId === undefined && chatRoomId === undefined;
  const hasValidRoom =
    parseQueryId(chatRoomId) !== null && (articleId === undefined || parseQueryId(articleId) !== null);
  const hasInvalidParams = !isList && !hasValidRoom;

  useEffect(() => {
    if (hasInvalidParams) {
      void routeNavigate({ href: ROUTES.LostItemChat(), replace: true });
    }
  }, [routeNavigate, hasInvalidParams]);

  if (!isLoggedIn || hasInvalidParams) return null;

  return (
    <LostItemChatPage
      articleIdParam={typeof articleId === 'string' ? articleId : null}
      chatRoomIdParam={typeof chatRoomId === 'string' ? chatRoomId : null}
    />
  );
}

export const Route = createFileRoute('/lost-item/chat/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  staticData: { requireAuth: true },
  component: RouteComponent,
});

function RouteComponent() {
  const page = <LostItemChatPageWrapper />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
