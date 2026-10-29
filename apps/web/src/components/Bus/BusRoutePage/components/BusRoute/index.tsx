import { cn } from '@bcsdlab/utils';

import BusIcon from 'assets/svg/Bus/bus-icon-28x28.svg';
import { SHORT_BUS_TYPE_MAP } from 'components/Bus/BusRoutePage/constants/busType';
import type { Schedule } from 'components/Bus/BusRoutePage/ts/types';
import { formatTimeDifference, formatTimeWithSeconds, isToday } from 'components/Bus/BusRoutePage/utils/timeModule';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useLiveNow from 'utils/hooks/state/useLiveNow';

import styles from './BusRoute.module.scss';

interface BusRouteProps {
  departDate: string; // yyyy-MM-dd
  schedule: Schedule;
}

export default function BusRoute({ departDate, schedule }: BusRouteProps) {
  const isMobile = useMediaQuery();
  // 남은 시간은 분 단위로만 보여주므로 1분마다 갱신한다.
  const now = useLiveNow(60_000);
  const { busType, busName, departTime } = schedule;

  return (
    <div className={styles.box}>
      <div className={styles['route-info']}>
        <div className={styles['bus-type']}>
          {!isMobile && (
            <div className={styles['bus-type__icon']}>
              <BusIcon />
            </div>
          )}
          <div
            className={cn({
              [styles['bus-type__chip']]: true,
              [styles[`bus-type__chip--${busType}`]]: true,
            })}
          >
            {SHORT_BUS_TYPE_MAP[busType]}
          </div>
          {busType === 'city' && <span className={styles['bus-type__bus-number']}>{`${busName}번`}</span>}
        </div>
        <div className={styles['depart-time']}>
          {`${Number(departTime.slice(0, 2)) < 12 ? '오전' : '오후'} ${departTime.slice(0, 5)}`}
        </div>
      </div>
      <div className={styles['before-arrive']}>
        <span className={styles['before-arrive__text']}>
          {isToday(new Date(departDate), now) ? formatTimeDifference(departTime, formatTimeWithSeconds(now)) : ''}
        </span>
      </div>
    </div>
  );
}
