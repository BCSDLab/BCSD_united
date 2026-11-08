import PenIcon from 'assets/svg/timetable-square-pen-icon.svg';
import showMobileToast from 'components/feedback/Toast/showMobileToast';
import HeaderIconButton from 'components/ui/PageHeader/HeaderIconButton';
import useLogger from 'utils/hooks/analytics/useLogger';

export function TimetableEditButton() {
  const logger = useLogger();

  return (
    <HeaderIconButton
      aria-label="시간표 수정"
      onClick={() => {
        // 시간표 2-23 시간표 수정 (모바일은 PC 안내만 띄운다)
        logger.actionEventClick({
          event_name: 'DA1',
          event_label: 'timetable__timetable__timetable_edit__entry__click',
          value: '시간표 수정',
        });
        showMobileToast('info', 'PC환경만 지원합니다. PC를 이용해주세요.');
      }}
    >
      <PenIcon />
    </HeaderIconButton>
  );
}
