import type { ChatMessageListRequest, ChatMessageResponse } from './entity';

export const CHAT_MESSAGE_LIMIT = 100;

export interface ChatMessageCache {
  messages: ChatMessageResponse[];
  initialized: boolean;
  lastFetchedMessageId?: string;
  lastReadMessageId?: string;
  hasPreviousMessages: boolean;
}

type FetchMessages = (params: ChatMessageListRequest) => Promise<ChatMessageResponse[]>;

export function createChatMessageCache(): ChatMessageCache {
  return { messages: [], initialized: false, hasPreviousMessages: false };
}

export function compareMessageIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId === rightId) return 0;

  return leftId < rightId ? -1 : 1;
}

export function mergeChatMessages(...lists: ChatMessageResponse[][]): ChatMessageResponse[] {
  const messages = new Map<string, ChatMessageResponse>();
  lists.forEach((list) => list.forEach((message) => messages.set(message.message_id, message)));

  return [...messages.values()].sort((left, right) => compareMessageIds(left.message_id, right.message_id));
}

function laterMessageId(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;

  return compareMessageIds(left, right) >= 0 ? left : right;
}

export function mergeChatMessageCache(
  previous: ChatMessageCache | undefined,
  next: ChatMessageCache,
): ChatMessageCache {
  if (!previous) return next;
  const previousOldest = previous.messages[0]?.message_id;
  const nextOldest = next.messages[0]?.message_id;
  let hasPreviousMessages = next.hasPreviousMessages;
  if (previousOldest && (!nextOldest || compareMessageIds(previousOldest, nextOldest) < 0)) {
    hasPreviousMessages = previous.hasPreviousMessages;
  } else if (previousOldest && previousOldest === nextOldest) {
    hasPreviousMessages = previous.hasPreviousMessages && next.hasPreviousMessages;
  }

  return {
    messages: mergeChatMessages(previous.messages, next.messages),
    initialized: previous.initialized || next.initialized,
    lastFetchedMessageId: laterMessageId(previous.lastFetchedMessageId, next.lastFetchedMessageId),
    lastReadMessageId: laterMessageId(previous.lastReadMessageId, next.lastReadMessageId),
    hasPreviousMessages,
  };
}

export async function fetchChatMessageCache(
  previous: ChatMessageCache | undefined,
  fetchMessages: FetchMessages,
): Promise<ChatMessageCache> {
  const cache = previous ?? createChatMessageCache();
  let messages = cache.messages;
  let cursor = cache.lastFetchedMessageId;
  let hasPreviousMessages = cache.hasPreviousMessages;
  const latest = await fetchMessages({ limit: CHAT_MESSAGE_LIMIT });
  const latestCursor = latest.at(-1)?.message_id;
  const oldestLatestMessageId = latest[0]?.message_id;
  messages = mergeChatMessages(messages, latest);

  if (!cursor) {
    hasPreviousMessages = latest.length === CHAT_MESSAGE_LIMIT;

    if (cache.initialized && latestCursor) {
      let page = latest;
      while (page.length === CHAT_MESSAGE_LIMIT) {
        const before = page[0].message_id;
        page = await fetchMessages({
          before_message_id: before,
          limit: CHAT_MESSAGE_LIMIT,
        });
        if (page.length && compareMessageIds(page[0].message_id, before) >= 0) {
          throw new Error('이전 메시지 조회가 진행되지 않았습니다.');
        }
        messages = mergeChatMessages(page, messages);
      }
      hasPreviousMessages = false;
    }
    cursor = latestCursor;
  } else if (oldestLatestMessageId && compareMessageIds(oldestLatestMessageId, cursor) > 0) {
    let page: ChatMessageResponse[];
    do {
      page = await fetchMessages({
        after_message_id: cursor,
        limit: CHAT_MESSAGE_LIMIT,
      });
      if (page.length) {
        const nextCursor = page.at(-1)!.message_id;
        if (compareMessageIds(nextCursor, cursor) <= 0) {
          throw new Error('새 메시지 조회가 진행되지 않았습니다.');
        }
        messages = mergeChatMessages(messages, page);
        cursor = nextCursor;
      }
    } while (page.length === CHAT_MESSAGE_LIMIT);
  } else {
    cursor = laterMessageId(cursor, latestCursor);
  }

  return {
    messages,
    initialized: true,
    lastFetchedMessageId: cursor,
    lastReadMessageId: cache.lastReadMessageId,
    hasPreviousMessages,
  };
}
