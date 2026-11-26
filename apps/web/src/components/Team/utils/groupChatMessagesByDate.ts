import type { ChatMessageResponse } from 'api/chat/entity';
import { formatChatDate } from 'utils/ts/chatTime';

export interface TeamChatMessageGroup {
  date: string;
  label: string;
  messages: ChatMessageResponse[];
}

export default function groupChatMessagesByDate(messages: ChatMessageResponse[]): TeamChatMessageGroup[] {
  return messages.reduce<TeamChatMessageGroup[]>((groups, message) => {
    const date = message.timestamp.slice(0, 10);
    const lastGroup = groups[groups.length - 1];

    if (lastGroup?.date === date) {
      lastGroup.messages.push(message);

      return groups;
    }

    groups.push({
      date,
      label: formatChatDate(message.timestamp),
      messages: [message],
    });

    return groups;
  }, []);
}
