import { useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { coopshopQueries } from 'api/coopshop/queries';
import PickerColumn from 'components/Bus/BusRoutePage/components/PickerColumn';
import type { useTimeSelect } from 'components/Bus/BusRoutePage/hooks/useTimeSelect';
import { useBusLogger } from 'components/Bus/hooks/useBusLogger';
import { useBodyScrollLock } from 'utils/hooks/ui/useBodyScrollLock';
import { useEscapeKeyDown } from 'utils/hooks/ui/useEscapeKeyDown';
import { useOutsideClick } from 'utils/hooks/ui/useOutsideClick';
import { useServerCalendarDate } from 'utils/ssr/useServerNow';
import { formatISODateTime } from 'utils/ts/calendar';

import styles from './TimeDetailMobile.module.scss';

interface TimeDetailMobileProps {
  timeSelect: ReturnType<typeof useTimeSelect>;
  close: () => void;
}

function formatSemesterLabel(semester?: string) {
  if (!semester) return '';
  const parts = semester.split('-');

  return (parts[1] ?? parts[0]).trim();
}

export default function TimeDetailMobile({ timeSelect, close }: TimeDetailMobileProps) {
  const { hour, minute } = timeSelect.timeState;
  const { setNow } = timeSelect.timeHandler;

  const { logDepartureNowClick, logDepartureTimeConfirm } = useBusLogger();
  // 창을 열었을 때의 값. 완료 시 이 값과 비교해 시간을 바꿨는지 판단한다
  const [initialPicker] = useState(() => ({
    dayOfMonthDiff: 0,
    meridiem: hour >= 12 ? 1 : 0,
    hour: hour % 12 || 12,
    minute,
  }));
  const [dayOfMonthDiff, setDayOfMonthDiff] = useState(initialPicker.dayOfMonthDiff);
  const [meridiem, setMeridiem] = useState(initialPicker.meridiem);
  const [selectedHour, setSelectedHour] = useState(initialPicker.hour);
  const [selectedMinute, setSelectedMinute] = useState(initialPicker.minute);

  const { data: semesterData } = useSuspenseQuery(coopshopQueries.allShopInfo());
  const { backgroundRef } = useOutsideClick({ onOutsideClick: close });
  const today = useServerCalendarDate();
  useBodyScrollLock();

  const handleNowDepartClick = () => {
    logDepartureNowClick();
    const now = new Date();
    setNow(now);
    close();
  };

  const handleCompleteClick = () => {
    logDepartureTimeConfirm(
      dayOfMonthDiff !== initialPicker.dayOfMonthDiff ||
        meridiem !== initialPicker.meridiem ||
        selectedHour !== initialPicker.hour ||
        selectedMinute !== initialPicker.minute,
    );
    const date = new Date(today);
    date.setDate(date.getDate() + dayOfMonthDiff);
    const hour = (selectedHour % 12) + (meridiem === 1 ? 12 : 0);
    setNow(new Date(`${formatISODateTime(date, hour, selectedMinute)}+09:00`));
    close();
  };

  const displaySemester = formatSemesterLabel(semesterData.semester);

  const dates = [...Array(90)].map((_, index) => {
    const now = new Date(today);
    now.setDate(now.getDate() + index);

    const daysOfWeek = ['일', '월', '화', '수', '목', '금', '토'];
    let label = `${now.getMonth() + 1}월 ${now.getDate()}일 (${daysOfWeek[now.getDay()]})`;
    if (index === 0) label = '오늘';
    if (index === 1) label = '내일';

    return label;
  });

  const hours = [...Array(12)].map((_, index) => index + 1);

  const minutes = [...Array(60)].map((_, index) => index);

  useEscapeKeyDown({ onEscape: close });

  return (
    <div className={styles.container} ref={backgroundRef}>
      <div className={styles.modal}>
        <div className={styles.guide}>
          <span className={styles.guide__title}>출발 시각 설정</span>
          <span className={styles.guide__description}>
            <div>
              {displaySemester}({semesterData.from_date} ~ {semesterData.to_date})
            </div>
            <div>시간표가 제공됩니다.</div>
          </span>
        </div>
        <div className={styles.picker}>
          <PickerColumn items={dates} selectedIndex={dayOfMonthDiff} onChange={setDayOfMonthDiff} flex={6} />
          <PickerColumn
            items={['오전', '오후']}
            selectedIndex={meridiem}
            onChange={(whether) => setMeridiem(() => whether)}
            flex={3}
          />
          <PickerColumn
            items={hours.map(String)}
            selectedIndex={selectedHour - 1}
            onChange={(index) => setSelectedHour(index + 1)}
            flex={2}
          />
          <PickerColumn
            items={minutes.map(String)}
            selectedIndex={selectedMinute}
            onChange={setSelectedMinute}
            flex={2}
          />
        </div>
        <div className={styles.buttons}>
          <button className={styles['buttons__now-depart']} type="button" onClick={handleNowDepartClick}>
            지금 출발
          </button>
          <button className={styles.buttons__complete} type="button" onClick={handleCompleteClick}>
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
