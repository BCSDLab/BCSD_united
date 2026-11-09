import useLogger from 'utils/hooks/analytics/useLogger';

const CLICK_EVENTS = [
  {
    key: 'message_list_select',
    label: 'chat__chat_list__chat_conversation__entry__click',
    value: '쪽지',
  },
] as const;

export type ClickEventKey = (typeof CLICK_EVENTS)[number]['key'];

export const useChatLogger = () => {
  const logger = useLogger();

  const logEvent = (eventKey: ClickEventKey, eventValue?: string) => {
    const event = CLICK_EVENTS.find(({ key }) => key === eventKey);
    if (event) {
      logger.actionEventClick({
        event_name: 'DA2',
        event_label: event.label,
        value: eventValue || event.value,
      });
    }
  };

  const logMessageListSelcetClick = () => logEvent('message_list_select');

  return {
    logMessageListSelcetClick,
  };
};
