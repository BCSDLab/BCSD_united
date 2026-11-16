import { useEffect, useRef } from 'react';
import { cn } from '@bcsdlab/utils';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';

import type { ChatRoomResponse } from 'api/chat/entity';
import { chatMutations } from 'api/chat/mutations';
import { chatQueries } from 'api/chat/queries';
import { TEAM_CHAT_POLLING_INTERVAL } from 'api/team/queries';
import DefaultPhotoIcon from 'assets/svg/Team/default-photo.svg';
import PeopleIcon from 'assets/svg/Team/people.svg';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import TeamChatSendBar from 'components/Team/components/TeamChatSendBar';
import { ChatLayout, ChatMessageList, ChatRoomList } from 'components/ui/Chat';
import ROUTES from 'static/routes';
import { useUser } from 'utils/hooks/state/useUser';
import useUploadFile from 'utils/hooks/uploadFile/useUploadFile';
import { formatChatRoomListTime } from 'utils/ts/chatTime';

import mapTeamChatMessageGroups from './mapTeamChatMessageGroups';
import styles from './TeamChatRoom.module.scss';

interface TeamChatRoomProps {
  recruitmentId: number;
  chatRoomId: number;
}

interface TeamChatRoomDetailProps {
  selectedRoom: ChatRoomResponse;
  chatRooms: ChatRoomResponse[];
  userId: number | null;
}

const PREVIOUS_MESSAGE_LOAD_THRESHOLD = 80;
const BOTTOM_STICK_THRESHOLD = 80;

const getChatRoomPreview = (room: ChatRoomResponse) => {
  if (room.last_message_is_image) return '사진을 보냈습니다.';

  return room.last_message_content ?? '';
};

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

export default function TeamChatRoom({ recruitmentId, chatRoomId }: TeamChatRoomProps) {
  const { data: user } = useUser();
  const userId = user?.id ?? null;
  const { data: chatRooms } = useSuspenseQuery({
    ...chatQueries.rooms(userId, 'TEAM_RECRUITMENT'),
    refetchInterval: TEAM_CHAT_POLLING_INTERVAL,
  });
  const selectedRoom = chatRooms.find((room) => room.context_id === recruitmentId && room.chat_room_id === chatRoomId);
  if (!selectedRoom) throw new Error('채팅방을 찾을 수 없습니다.');

  return (
    <TeamChatRoomDetail key={selectedRoom.room_id} selectedRoom={selectedRoom} chatRooms={chatRooms} userId={userId} />
  );
}

function TeamChatRoomDetail({ selectedRoom, chatRooms, userId }: TeamChatRoomDetailProps) {
  const queryClient = useQueryClient();
  const roomId = selectedRoom.room_id;
  const { data: chatRoom } = useSuspenseQuery({
    ...chatQueries.room(userId, roomId),
    staleTime: 60_000,
  });
  const { data: messageCache } = useSuspenseQuery({
    ...chatQueries.messages(queryClient, userId, roomId),
    refetchInterval: TEAM_CHAT_POLLING_INTERVAL,
  });
  const { messages, hasPreviousMessages } = messageCache;
  const { uploadFile, isPending: isUploading } = useUploadFile();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isFetchingPreviousMessagesRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const hasInitialScrollRef = useRef(false);

  const { mutate: sendMessage, isPending: isSending } = useMutation(
    chatMutations.sendMessage(queryClient, userId, roomId),
  );
  const { mutateAsync: loadPreviousMessagesAsync } = useMutation(
    chatMutations.loadPreviousMessages(queryClient, userId, roomId),
  );
  const { mutate: markRead } = useMutation(chatMutations.markRead(queryClient, userId, roomId));
  const oldestMessageId = messages[0]?.message_id;
  const lastMessageId = messages[messages.length - 1]?.message_id;

  useEffect(() => {
    if (!hasInitialScrollRef.current || shouldStickToBottomRef.current) {
      const container = messagesContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
      hasInitialScrollRef.current = true;
    }
  }, [lastMessageId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !chatRoom.supports_read_receipts) return;
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
  }, [messages, chatRoom.supports_read_receipts, markRead]);

  const sidebarItems = chatRooms.map((room) => ({
    key: room.room_id,
    href: ROUTES.TeamChat({
      recruitmentId: String(room.context_id),
      chatRoomId: String(room.chat_room_id),
    }),
    title: room.room_name,
    timeLabel: room.last_message_at ? formatChatRoomListTime(room.last_message_at) : undefined,
    preview: getChatRoomPreview(room),
    unreadCount: room.unread_message_count,
    avatar: <DefaultPhotoIcon />,
    avatarAriaHidden: true,
    isActive: room.room_id === selectedRoom.room_id,
  }));

  const isTeamRoom = chatRoom.room_type === 'GROUP';
  const messageGroups = mapTeamChatMessageGroups(messages, userId ?? undefined);
  const memberCount = isTeamRoom && chatRoom.member_count !== null && chatRoom.max_member_count !== null && (
    <span
      className={cn({
        [styles['chat-room__memberCount']]: true,
        [styles['chat-room__memberCount--full']]: chatRoom.member_count >= chatRoom.max_member_count,
      })}
    >
      <PeopleIcon />
      {chatRoom.member_count}/{chatRoom.max_member_count}
    </span>
  );

  const loadPreviousMessages = async () => {
    const container = messagesContainerRef.current;
    if (!container || !oldestMessageId || !hasPreviousMessages || isFetchingPreviousMessagesRef.current) return;

    isFetchingPreviousMessagesRef.current = true;
    const anchorMessage = container.querySelector<HTMLElement>('[data-message-id]');
    const anchorMessageId = anchorMessage?.dataset.messageId;
    const anchorTop = anchorMessage?.getBoundingClientRect().top;

    try {
      const page = await loadPreviousMessagesAsync();
      if (page && page.messages.length > 0) {
        requestAnimationFrame(() => {
          if (!anchorMessageId || anchorTop === undefined) return;

          const restoredAnchor = container.querySelector<HTMLElement>(`[data-message-id="${anchorMessageId}"]`);
          if (restoredAnchor) {
            container.scrollTop += restoredAnchor.getBoundingClientRect().top - anchorTop;
          }
        });
      }
    } catch {
      // 오류 표시는 공통 mutation에서 처리한다.
    } finally {
      isFetchingPreviousMessagesRef.current = false;
    }
  };

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= BOTTOM_STICK_THRESHOLD;

    if (container.scrollTop <= PREVIOUS_MESSAGE_LOAD_THRESHOLD) {
      void loadPreviousMessages();
    }
  };

  const handleSend = (content: string) => {
    if (chatRoom.can_send) sendMessage({ content, is_image: false });
  };

  const handleImageSelect = async (file: File) => {
    if (!chatRoom.can_send) return;

    try {
      const { file_url } = await uploadFile({ domain: 'TEAM_RECRUITMENT', file });
      if (file_url) {
        sendMessage({ content: file_url, is_image: true });
      }
    } catch {}
  };

  return (
    <ChatLayout
      className={styles.chat}
      sidebarClassName={styles.chat__sidebar}
      panelClassName={styles['chat-room']}
      sidebar={<ChatRoomList items={sidebarItems} />}
    >
      <MobilePageHeader title={chatRoom.room_name} rightAction={memberCount} />
      <div className={styles['chat-room__desktopHeader']}>
        <h2>{chatRoom.room_name}</h2>
        {memberCount}
      </div>
      <div ref={messagesContainerRef} className={styles['chat-room__messages']} onScroll={handleMessagesScroll}>
        <ChatMessageList
          groups={messageGroups}
          classNames={{
            dateContainer: styles['chat-room__dateChip'],
            dateLabel: styles['chat-room__dateLabel'],
            bubbleMine: styles['chat-room__bubble'],
            bubbleOthers: styles['chat-room__bubble'],
            imageBubble: styles['chat-room__imageBubble'],
          }}
        />
      </div>
      <TeamChatSendBar
        disabled={isSending || isUploading || !chatRoom.can_send}
        onSend={handleSend}
        onImageSelect={handleImageSelect}
      />
    </ChatLayout>
  );
}
