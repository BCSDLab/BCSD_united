import {
  useRef,
  type ChangeEvent,
  type Key,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { Link } from '@tanstack/react-router';

import ImageUploadIcon from 'assets/svg/common/chat-photo.svg';
import SendIcon from 'assets/svg/common/chat-send.svg';
import TranslateButton from 'components/translation/TranslateButton';
import useContentTranslation, { type UseContentTranslationOptions } from 'components/translation/useContentTranslation';
import useHasBeenVisible from 'utils/hooks/ui/useHasBeenVisible';
import { parseSearch } from 'utils/routing/search';

import styles from './Chat.module.scss';

interface ChatRoomListItem {
  key: Key;
  href: string;
  title: string;
  timeLabel?: string;
  preview: string;
  unreadCount: number;
  avatar: ReactNode;
  avatarAriaHidden?: boolean;
  isActive?: boolean;
  onClick?: () => void;
}

interface ChatRoomListProps {
  items: ChatRoomListItem[];
}

export interface ChatMessageListItem {
  key: Key;
  messageId?: string | number;
  isMine: boolean;
  content: string;
  isImage: boolean;
  timeLabel: string;
  unreadCount?: number;
  senderId: number;
  senderName?: string;
  senderAvatar?: ReactNode;
  /** 번역 버튼을 붙일 메시지의 번역 정보. 상대가 보낸 텍스트 쪽지에만 넘긴다. */
  translation?: ChatMessageTranslation;
}

/** 쪽지 번역 정보. 메시지가 화면에 처음 보일 때 번역 버튼을 보여줄지 서버에 확인한다. */
export type ChatMessageTranslation = Omit<UseContentTranslationOptions, 'enabled'>;

export interface ChatMessageListGroup {
  key: Key;
  dateLabel: string;
  messages: ChatMessageListItem[];
}

interface ChatMessageListClassNames {
  dateContainer?: string;
  dateLabel?: string;
  bubbleMine?: string;
  bubbleOthers?: string;
  imageBubble?: string;
}

interface ChatMessageListProps {
  groups: ChatMessageListGroup[];
  classNames?: ChatMessageListClassNames;
}

interface ChatMessageInputClassNames {
  container?: string;
  imageControl?: string;
  textarea?: string;
  sendButton?: string;
}

interface ChatMessageInputProps {
  classNames?: ChatMessageInputClassNames;
  value: string;
  onChange: (value: string) => void;
  onSend: () => boolean | void;
  onImageChange: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  placeholder?: string;
  fileInputRef?: RefObject<HTMLInputElement | null>;
  imageInputMultiple?: boolean;
}

interface ChatLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
  sidebarClassName?: string;
  panelClassName?: string;
}

const joinClassNames = (...classNames: Array<string | false | undefined>) => classNames.filter(Boolean).join(' ');

export function ChatLayout({ sidebar, children, className, sidebarClassName, panelClassName }: ChatLayoutProps) {
  const hasSidebar = Boolean(sidebar);

  return (
    <div
      className={joinClassNames(
        styles['chat-layout'],
        !hasSidebar && styles['chat-layout--without-sidebar'],
        className,
      )}
    >
      {hasSidebar && (
        <aside className={joinClassNames(styles['chat-layout__sidebar'], sidebarClassName)} aria-label="채팅방 목록">
          {sidebar}
        </aside>
      )}
      {children && (
        <section className={joinClassNames(styles['chat-layout__panel'], panelClassName)}>{children}</section>
      )}
    </div>
  );
}

export function ChatRoomList({ items }: ChatRoomListProps) {
  if (items.length === 0) {
    return <div className={styles['room-list__empty']}>채팅방이 없습니다.🧐</div>;
  }

  return items.map((item) => (
    <Link
      key={item.key}
      to={item.href.split('?')[0]}
      search={parseSearch(item.href.split('?')[1] ?? '')}
      className={joinClassNames(styles['room-list__item'], item.isActive && styles['room-list__item--active'])}
      aria-current={item.isActive ? 'page' : undefined}
      onClick={item.onClick}
    >
      <div className={styles['room-list__avatar']} aria-hidden={item.avatarAriaHidden}>
        {item.avatar}
      </div>
      <div className={styles['room-list__content']}>
        <div className={styles['room-list__header']}>
          <div className={styles['room-list__title']}>{item.title}</div>
          {item.timeLabel && <div className={styles['room-list__time']}>{item.timeLabel}</div>}
        </div>
        <div className={styles['room-list__preview-row']}>
          <div className={styles['room-list__preview']}>{item.preview}</div>
          {item.unreadCount > 0 && <div className={styles['room-list__unread-count']}>{item.unreadCount}</div>}
        </div>
      </div>
    </Link>
  ));
}

interface ChatMessageViewProps {
  message: ChatMessageListItem;
  showSender: boolean;
  classNames: ChatMessageListClassNames;
  /** 말풍선에 보여줄 글. 번역을 보고 있으면 번역문이다. */
  text: string;
  /** 상대 메시지의 번역 버튼. PC는 시간 위, 모바일은 말풍선 아래에 둔다. */
  action?: ReactNode;
  /** 번역 중이거나 번역문을 보여주는 중이다. 모바일은 말풍선 색을 진하게 한다. */
  isTranslated?: boolean;
  itemRef?: Ref<HTMLDivElement>;
}

function ChatMessageView({
  message,
  showSender,
  classNames,
  text,
  action,
  isTranslated = false,
  itemRef,
}: ChatMessageViewProps) {
  let bubbleClassName = message.isMine
    ? joinClassNames(styles['message-list__bubble'], styles['message-list__bubble--mine'], classNames.bubbleMine)
    : joinClassNames(
        styles['message-list__bubble'],
        styles['message-list__bubble--other'],
        isTranslated && styles['message-list__bubble--translated'],
        classNames.bubbleOthers,
      );
  if (message.isImage) bubbleClassName = joinClassNames(styles['message-list__image-bubble'], classNames.imageBubble);

  const bubble = (
    <div className={bubbleClassName}>
      {message.isImage ? (
        // 채팅 이미지의 원본 비율을 유지하고 CSS로 표시 크기를 제한한다.
        <img src={message.content} alt="전송된 이미지" className={styles['message-list__image']} />
      ) : (
        text
      )}
    </div>
  );

  const meta = (
    <div className={joinClassNames(styles['message-list__meta'], message.isMine && styles['message-list__meta--mine'])}>
      {(message.unreadCount ?? 0) > 0 && (
        <span className={styles['message-list__unread-count']}>{message.unreadCount}</span>
      )}
      <span className={styles['message-list__time']}>{message.timeLabel}</span>
    </div>
  );

  if (message.isMine) {
    return (
      <div
        ref={itemRef}
        className={joinClassNames(styles['message-list__item'], styles['message-list__item--mine'])}
        data-message-id={message.messageId}
      >
        {meta}
        {bubble}
      </div>
    );
  }

  return (
    <div
      ref={itemRef}
      className={joinClassNames(
        styles['message-list__item'],
        styles['message-list__item--other'],
        !showSender && styles['message-list__item--consecutive'],
      )}
      data-message-id={message.messageId}
    >
      {showSender && (
        <div className={styles['message-list__sender']}>
          {message.senderAvatar}
          <span className={styles['message-list__sender-name']}>{message.senderName}</span>
        </div>
      )}
      <div
        className={joinClassNames(styles['message-list__row'], !!action && styles['message-list__row--with-action'])}
      >
        {bubble}
        {action && <div className={styles['message-list__action']}>{action}</div>}
        {meta}
      </div>
    </div>
  );
}

function TranslatableChatMessage({
  translation,
  ...props
}: Omit<ChatMessageViewProps, 'text' | 'action' | 'isTranslated' | 'itemRef'> & {
  translation: ChatMessageTranslation;
}) {
  // 확인 요청이 메시지마다 나가므로, 화면에 보이기 전에는 보내지 않는다
  const [itemRef, hasBeenVisible] = useHasBeenVisible<HTMLDivElement>();
  const { canTranslate, state, translated, toggle } = useContentTranslation<{ content: string }>({
    ...translation,
    enabled: hasBeenVisible,
  });

  return (
    <ChatMessageView
      {...props}
      itemRef={itemRef}
      text={translated?.content ?? props.message.content}
      isTranslated={state !== 'original'}
      action={canTranslate && <TranslateButton variant="message" state={state} onClick={toggle} />}
    />
  );
}

export function ChatMessageList({ groups, classNames = {} }: ChatMessageListProps) {
  const renderMessage = (message: ChatMessageListItem, previousMessage?: ChatMessageListItem) => {
    const showSender =
      !previousMessage ||
      message.senderId !== previousMessage.senderId ||
      message.timeLabel !== previousMessage.timeLabel;

    if (message.translation) {
      return (
        <TranslatableChatMessage
          key={message.key}
          message={message}
          showSender={showSender}
          classNames={classNames}
          translation={message.translation}
        />
      );
    }

    return (
      <ChatMessageView
        key={message.key}
        message={message}
        showSender={showSender}
        classNames={classNames}
        text={message.content}
      />
    );
  };

  return groups.map((group) => (
    <div key={group.key}>
      <div className={joinClassNames(styles['message-list__date'], classNames.dateContainer)}>
        <span className={joinClassNames(styles['message-list__date-label'], classNames.dateLabel)}>
          {group.dateLabel}
        </span>
      </div>
      {group.messages.map((message, index) => renderMessage(message, group.messages[index - 1]))}
    </div>
  ));
}

export function ChatMessageInput({
  classNames = {},
  value,
  onChange,
  onSend,
  onImageChange,
  disabled = false,
  placeholder = '메세지 보내기',
  fileInputRef,
  imageInputMultiple = false,
}: ChatMessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const internalFileInputRef = useRef<HTMLInputElement>(null);
  const resolvedFileInputRef = fileInputRef ?? internalFileInputRef;

  const resizeTextarea = () => {
    if (!textareaRef.current) return;

    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
    resizeTextarea();
  };

  const handleSend = () => {
    if (!value.trim() || disabled) return;
    if (onSend() === false) return;

    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={joinClassNames(styles['message-input'], classNames.container)}>
      <button
        type="button"
        className={joinClassNames(styles['message-input__image-button'], classNames.imageControl)}
        aria-label="이미지 전송"
        onClick={() => resolvedFileInputRef.current?.click()}
        disabled={disabled}
      >
        <ImageUploadIcon />
      </button>
      <input
        ref={resolvedFileInputRef}
        type="file"
        accept="image/*"
        multiple={imageInputMultiple}
        className={styles['message-input__file']}
        onChange={onImageChange}
        disabled={disabled}
        aria-label="이미지 파일 선택"
      />
      <textarea
        ref={textareaRef}
        className={joinClassNames(styles['message-input__textarea'], classNames.textarea)}
        placeholder={placeholder}
        aria-label="메시지 입력"
        rows={1}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <button
        type="button"
        className={joinClassNames(styles['message-input__send-button'], classNames.sendButton)}
        aria-label="전송"
        onClick={handleSend}
        disabled={disabled}
      >
        <SendIcon />
      </button>
    </div>
  );
}
