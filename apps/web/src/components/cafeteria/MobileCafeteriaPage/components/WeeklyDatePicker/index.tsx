import { cn } from '@bcsdlab/utils';

import { useCafeteriaLiveNow } from 'components/cafeteria/hooks/useCafeteriaLiveNow';
import { useCafeteriaParams } from 'components/cafeteria/hooks/useCafeteriaParams';
import { kstDateKey, kstDayOfWeek } from 'utils/ts/calendar';

import styles from './WeeklyDatePicker.module.scss';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export default function WeeklyDatePicker() {
  const { date } = useCafeteriaParams();
  const today = useCafeteriaLiveNow();

  const thisWeek = Array.from({ length: 7 }, (_, index) => new Date(today.getTime() + (index - 3) * 86400000));
  const dateFormat = (d = today) => kstDateKey(d);

  return (
    <div className={styles.container}>
      <div className={styles.picker}>
        <div className={styles.picker__container}>
          {thisWeek.map((day) => (
            <div
              className={cn({
                [styles.picker__date]: true,
                [styles['picker__date--before']]: dateFormat(day) < dateFormat(),
              })}
              key={dateFormat(day)}
            >
              {WEEK[kstDayOfWeek(day)]}
              <button
                className={cn({
                  [styles.picker__button]: true,
                  [styles['picker__button--before']]: dateFormat(day) < dateFormat(),
                  [styles['picker__button--selected']]: dateFormat(day) === dateFormat(date.current()),
                  [styles['picker__button--today']]: dateFormat(day) === dateFormat(),
                })}
                type="button"
                onClick={() => date.set(day)}
              >
                {dateFormat(day) === dateFormat() && <div className={styles['picker__button--selector']} />}
                {Number(dateFormat(day).slice(-2))}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
