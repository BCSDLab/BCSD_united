import { useState } from 'react';

import { formatDate, formatTime } from 'components/Bus/BusRoutePage/utils/timeModule';
import { useServerNow } from 'utils/ssr/useServerNow';
import { toKoreanCalendarDate } from 'utils/ts/calendar';

interface TimeState {
  nowDate: Date;
  dayOfMonth: number;
  hour: number;
  minute: number;
}

interface TimeHandlers {
  setNow: (date: Date) => void;
  setDayOfMonth: (date: number) => void;
  setHour: (hour: number) => void;
  setMinute: (minute: number) => void;
}

interface FormattedTime {
  date: string; // 'YYYY-MM-DD'
  time: string; // 'HH:mm'
}

export interface UseTimeSelectReturn {
  timeState: TimeState;
  timeHandler: TimeHandlers;
  formattedValues: FormattedTime;
}

export const useTimeSelect = (): UseTimeSelectReturn => {
  const now = useServerNow();
  const nowDate = toKoreanCalendarDate(now);
  const [timeState, setTimeState] = useState({
    nowDate,
    dayOfMonth: nowDate.getDate(),
    hour: (now.getUTCHours() + 9) % 24,
    minute: now.getUTCMinutes(),
  });

  const timeHandler = {
    setNow: (date: Date) => {
      const calendarDate = toKoreanCalendarDate(date);
      setTimeState({
        nowDate: calendarDate,
        dayOfMonth: calendarDate.getDate(),
        hour: (date.getUTCHours() + 9) % 24,
        minute: date.getUTCMinutes(),
      });
    },
    setDayOfMonth: (dateDiff: number) =>
      setTimeState((prev) => {
        const newDate = new Date(nowDate);
        newDate.setDate(newDate.getDate() + dateDiff);

        return {
          ...prev,
          nowDate: newDate,
          dayOfMonth: newDate.getDate(),
        };
      }),
    setHour: (hour: number) => setTimeState((prev) => ({ ...prev, hour })),
    setMinute: (minute: number) => setTimeState((prev) => ({ ...prev, minute })),
  };

  const formattedValues = {
    date: formatDate(timeState.nowDate, timeState.dayOfMonth),
    time: formatTime(timeState.hour, timeState.minute),
  };

  return {
    timeState,
    timeHandler,
    formattedValues,
  };
};
