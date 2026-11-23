import useLogger from 'utils/hooks/analytics/useLogger';
import useGoBack from 'utils/hooks/routing/useGoBack';

export default function useRoomBack(sourceScreen: 'room_list' | 'room_detail', fallback?: string) {
  const logger = useLogger();
  const goBack = useGoBack();

  return () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'real_estate__room_common__navigation__back__click',
      value: '뒤로가기',
      params: { source_screen: sourceScreen },
    });
    goBack(fallback);
  };
}
