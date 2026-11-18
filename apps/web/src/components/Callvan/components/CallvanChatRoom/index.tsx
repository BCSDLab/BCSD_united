import { useRef, useState, useEffect, useMemo } from 'react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import { callvanQueries } from 'api/callvan/queries';
import type { ChatMessageResponse, ChatRoomResponse } from 'api/chat/entity';
import { chatMutations } from 'api/chat/mutations';
import { chatQueries } from 'api/chat/queries';
import ArrowBackIcon from 'assets/svg/Callvan/arrow-back.svg';
import PeopleIcon from 'assets/svg/Callvan/people.svg';
import ImageUploadIcon from 'assets/svg/common/image-upload.svg';
import SendIcon from 'assets/svg/common/send.svg';
import { ParticipantAvatarIcon } from 'components/Callvan/components/ParticipantsList/ParticipantAvatarIcon';
import useSendCallvanChat from 'components/Callvan/hooks/useSendCallvanChat';
import { getParticipantColor } from 'components/Callvan/utils/participantColor';
import useLogger from 'utils/hooks/analytics/useLogger';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import { useUser } from 'utils/hooks/state/useUser';
import useUploadFile from 'utils/hooks/uploadFile/useUploadFile';

import styles from './CallvanChatRoom.module.scss';

interface CallvanChatRoomProps {
  postId: number;
}

interface CallvanChatRoomContentProps {
  room: ChatRoomResponse;
  userId: number | null;
}

interface CallvanMessageView extends ChatMessageResponse {
  date: string;
  time: string;
  is_mine: boolean;
}

const CHAT_POLLING_INTERVAL_MS = 1000;

function toMessageView(message: ChatMessageResponse, userId: number | null): CallvanMessageView {
  const hour = Number(message.timestamp.slice(11, 13));

  return {
    ...message,
    date: message.timestamp.slice(0, 10).replaceAll('-', '. '),
    time: `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${message.timestamp.slice(14, 16)}`,
    is_mine: userId !== null && message.user_id === userId,
  };
}

function groupMessagesByDate(messages: CallvanMessageView[]): Array<{ date: string; messages: CallvanMessageView[] }> {
  const groups: Array<{ date: string; messages: CallvanMessageView[] }> = [];

  messages.forEach((msg) => {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.date === msg.date) {
      lastGroup.messages.push(msg);
    } else {
      groups.push({ date: msg.date, messages: [msg] });
    }
  });

  return groups;
}

function findLastVisibleMessageId(container: HTMLDivElement): string | undefined {
  const bounds = container.getBoundingClientRect();
  const visibleTop = Math.max(bounds.top, 0);
  const visibleBottom = Math.min(bounds.bottom, window.innerHeight);
  if (bounds.width === 0 || visibleTop >= visibleBottom) return undefined;

  const elements = container.querySelectorAll<HTMLElement>('[data-message-id]');
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    const messageBounds = element.getBoundingClientRect();
    if (messageBounds.bottom > visibleTop && messageBounds.top < visibleBottom) {
      return element.dataset.messageId;
    }
  }

  return undefined;
}

function formatKoreanDateString(dateStr: string): string {
  const parts = dateStr.match(/\d+/g);
  if (parts && parts.length >= 3) {
    return `${parts[0]}년 ${parts[1]}월 ${parts[2]}일`;
  }

  return dateStr;
}

export default function CallvanChatRoom({ postId }: CallvanChatRoomProps) {
  const { data: user } = useUser();
  const userId = user?.id ?? null;
  const { data: rooms } = useSuspenseQuery(chatQueries.rooms(userId, 'CALLVAN'));
  const room = rooms.find((candidate) => candidate.context_id === postId);
  if (!room) throw new Error('채팅방을 찾을 수 없습니다.');

  return <CallvanChatRoomContent key={room.room_id} room={room} userId={userId} />;
}

function CallvanChatRoomContent({ room, userId }: CallvanChatRoomContentProps) {
  const router = useRouter();
  const logger = useLogger();
  const isLoggedIn = useIsLoggedIn();
  const queryClient = useQueryClient();
  const postId = room.context_id;
  const roomId = room.room_id;
  const { data: messageCache } = useSuspenseQuery({
    ...chatQueries.messages(queryClient, userId, roomId),
    refetchInterval: CHAT_POLLING_INTERVAL_MS,
  });
  const messages = useMemo(
    () => messageCache.messages.map((message) => toMessageView(message, userId)),
    [messageCache.messages, userId],
  );
  const { data: postDetail } = useSuspenseQuery(callvanQueries.postDetail(postId, isLoggedIn));
  const { mutate: markRead } = useMutation(chatMutations.markRead(queryClient, userId, roomId));
  const { mutateAsync: loadPreviousMessagesAsync } = useMutation(
    chatMutations.loadPreviousMessages(queryClient, userId, roomId),
  );

  const { mutate: sendMessage, isPending: isSending } = useSendCallvanChat(userId, roomId);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isFetchingPreviousMessagesRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { uploadFile, isPending: isUploading } = useUploadFile();
  const lastMessageId = messageCache.messages[messageCache.messages.length - 1]?.message_id;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView();
  }, [lastMessageId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !room.supports_read_receipts) return;
    let animationFrame: number | undefined;

    const markVisibleMessages = () => {
      animationFrame = undefined;
      if (document.visibilityState !== 'visible') return;
      const messageId = findLastVisibleMessageId(container);
      if (messageId) markRead(messageId);
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
  }, [messageCache.messages, room.supports_read_receipts, markRead]);

  const loadPreviousMessages = async () => {
    const container = messagesContainerRef.current;
    if (!container || !messageCache.hasPreviousMessages || isFetchingPreviousMessagesRef.current) return;
    isFetchingPreviousMessagesRef.current = true;
    const anchor = container.querySelector<HTMLElement>('[data-message-id]');
    const anchorId = anchor?.dataset.messageId;
    const anchorTop = anchor?.getBoundingClientRect().top;

    try {
      const page = await loadPreviousMessagesAsync();
      if (page && page.messages.length > 0) {
        requestAnimationFrame(() => {
          if (!anchorId || anchorTop === undefined) return;
          const restoredAnchor = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
          if (restoredAnchor) container.scrollTop += restoredAnchor.getBoundingClientRect().top - anchorTop;
        });
      }
    } catch {
      // 오류 표시는 공통 mutation에서 처리한다.
    } finally {
      isFetchingPreviousMessagesRef.current = false;
    }
  };

  const handleMessagesScroll = () => {
    if (messagesContainerRef.current && messagesContainerRef.current.scrollTop <= 0) {
      void loadPreviousMessages();
    }
  };

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const { file_url } = await uploadFile({ domain: 'CALLVAN_CHAT', file });
      if (file_url) {
        sendMessage({ is_image: true, content: file_url });
      }
    } finally {
      e.target.value = '';
    }
  };

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleSend = () => {
    const content = inputValue.trim();
    if (!content || isSending) return;

    sendMessage(
      { is_image: false, content },
      {
        onSuccess: () => {
          setInputValue('');
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
        },
      },
    );
    logger.actionEventClick({ event_label: 'callvan_chat_send', team: 'CAMPUS', value: '' });
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const senderColorMap = new Map<number | null, number>();

  messages.forEach((message) => {
    if (!message.is_mine && !senderColorMap.has(message.user_id)) {
      senderColorMap.set(message.user_id, senderColorMap.size);
    }
  });

  const messageGroups = groupMessagesByDate(messages);

  return (
    <div className={styles['chat-room']}>
      <div className={styles['chat-room__header']}>
        <button type="button" className={styles['chat-room__back-button']} onClick={() => router.history.back()}>
          <ArrowBackIcon />
        </button>
        <div className={styles['chat-room__header-center']}>
          <div className={styles['chat-room__title-row']}>
            <span className={styles['chat-room__route-text']}>{postDetail.departure}</span>
            <span>-</span>
            <span className={styles['chat-room__route-text']}>{postDetail.arrival}</span>
            <span>{postDetail.departure_time}</span>
          </div>
          <div className={styles['chat-room__header-count']}>
            <PeopleIcon />
            <span>
              {postDetail.current_participants}/{postDetail.max_participants}
            </span>
          </div>
        </div>
        <div className={styles['chat-room__header-menu']} />
      </div>

      <div className={styles['chat-room__messages']} ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {messageGroups.length === 0 && <div className={styles['chat-room__empty']}>아직 대화가 없습니다.</div>}

        {messageGroups.map((group) => (
          <div key={group.date}>
            <div className={styles['chat-room__date-badge']}>
              <span>{formatKoreanDateString(group.date)}</span>
            </div>

            {group.messages.map((msg, idx) => {
              const key = msg.message_id;

              if (msg.is_mine) {
                return (
                  <div key={key} className={styles['chat-room__message-row--mine']} data-message-id={msg.message_id}>
                    {msg.unread_count > 0 ? (
                      <div className={styles['chat-room__textheader--mine']}>
                        <span className={styles['chat-room__unread-count']}>{msg.unread_count}</span>
                        <span className={styles['chat-room__timestamp']}>{msg.time}</span>
                      </div>
                    ) : (
                      <span className={styles['chat-room__timestamp']}>{msg.time}</span>
                    )}
                    {msg.is_image ? (
                      <div className={styles['chat-room__bubble-image']}>
                        {/* 채팅 이미지마다 크기가 달라 원본 비율로 표시한다. */}
                        <img src={msg.content} alt="업로드 이미지" />
                      </div>
                    ) : (
                      <div className={styles['chat-room__bubble--mine']}>
                        <span className={styles['chat-room__message-text']}>{msg.content}</span>
                      </div>
                    )}
                  </div>
                );
              }

              const showSender = idx === 0 || group.messages[idx - 1].user_id !== msg.user_id;

              return (
                <div
                  key={key}
                  data-message-id={msg.message_id}
                  className={
                    showSender
                      ? styles['chat-room__message-group--others']
                      : styles['chat-room__message-group--others-consecutive']
                  }
                >
                  {showSender && (
                    <div className={styles['chat-room__sender-row']}>
                      <ParticipantAvatarIcon color={getParticipantColor(senderColorMap.get(msg.user_id) ?? 0)} />
                      <div className={styles['chat-room__sender-info']}>
                        <span className={styles['chat-room__sender-name']}>{msg.user_nickname}</span>
                        {msg.is_left_user && <span className={styles['chat-room__left-badge']}>(나간 사용자)</span>}
                      </div>
                    </div>
                  )}
                  <div className={styles['chat-room__message-row--others']}>
                    {msg.is_image ? (
                      <div className={styles['chat-room__bubble-image']}>
                        {/* 채팅 이미지마다 크기가 달라 원본 비율로 표시한다. */}
                        <img src={msg.content} alt="업로드 이미지" />
                      </div>
                    ) : (
                      <div className={styles['chat-room__bubble--others']}>
                        <span className={styles['chat-room__message-text']}>{msg.content}</span>
                      </div>
                    )}
                    {msg.unread_count > 0 ? (
                      <div className={styles['chat-room__textheader--others']}>
                        <span className={styles['chat-room__unread-count']}>{msg.unread_count}</span>
                        <span className={styles['chat-room__timestamp']}>{msg.time}</span>
                      </div>
                    ) : (
                      <span className={styles['chat-room__timestamp']}>{msg.time}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      <div className={styles['chat-room__send-bar']}>
        <button
          type="button"
          className={styles['chat-room__image-button']}
          aria-label="이미지 전송"
          onClick={handleImageClick}
          disabled={isUploading}
        >
          <ImageUploadIcon />
        </button>
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleImageFileChange}
        />
        <textarea
          className={styles['chat-room__input']}
          placeholder="메세지 보내기"
          value={inputValue}
          rows={1}
          ref={textareaRef}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className={styles['chat-room__send-button']}
          onClick={handleSend}
          disabled={!inputValue.trim() || isSending}
          aria-label="전송"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
