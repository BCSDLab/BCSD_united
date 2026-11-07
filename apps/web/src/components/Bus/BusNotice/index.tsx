import { useEffect, useState } from 'react';
import { cn } from '@bcsdlab/utils';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import { busQueries } from 'api/bus/queries';
import InformationIcon from 'assets/svg/Bus/info.svg';
import CloseIcon from 'assets/svg/common/close/close-icon-32x32.svg';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import { useLocalStorage } from 'utils/hooks/state/useLocalStorage';

import styles from './BusNotice.module.scss';

export interface BusNoticeProps {
  loggingLocation?: string;
  variant?: 'timetable';
}

const LOCATION = [
  {
    location: 'bus_search',
    value: '버스 교통편',
  },
  {
    location: 'shuttle',
    value: '셔틀',
  },
  {
    location: 'express',
    value: '대성',
  },
  {
    location: 'city',
    value: '시내',
  },
];

export default function BusNotice({ loggingLocation, variant }: BusNoticeProps) {
  const isMobile = useMediaQuery();
  const router = useRouter();
  const navigate = (path: string) => router.navigate({ href: path });
  const { data } = useSuspenseQuery(busQueries.notice());
  const { id, title } = data;
  const [lastBusNotice, setLastBusNotice] = useLocalStorage('lastBusNotice', '');
  const [busNoticeDismissed, setBusNoticeDismissed] = useLocalStorage('busNoticeDismissed', 'false');
  const isDismissed = busNoticeDismissed === 'true';
  const isUpdated = lastBusNotice !== title;
  const logger = useLogger();
  const matched = LOCATION.find((item) => item.location === loggingLocation);
  const logValue = matched?.value || '';

  const [showNotice, setShowNotice] = useState(() => !isDismissed || isUpdated);

  const handleClickNavigateNotice = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'bus__bus_timetable__bus_notice__open__click',
      value: logValue,
    });
    navigate(ROUTES.ArticlesDetail({ id: String(id) }));
  };

  const handleClickDismissNotice = () => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'bus__bus_timetable__bus_notice__close__click',
      value: logValue,
    });
    setBusNoticeDismissed('true');
    setShowNotice(false);
  };

  useEffect(() => {
    if (isUpdated) {
      setLastBusNotice(title);
      setBusNoticeDismissed('false');
    }
  }, [isUpdated, title, setLastBusNotice, setBusNoticeDismissed]);

  return (
    <div
      className={cn({
        [styles.container]: true,
        [styles['container--timetable']]: variant === 'timetable',
      })}
    >
      {showNotice && (
        <div className={styles.notice}>
          {!isMobile && <InformationIcon />}
          <button className={styles.notice__description} type="button" onClick={handleClickNavigateNotice}>
            {title}
          </button>
          <button
            className={styles.notice__close}
            type="button"
            onClick={handleClickDismissNotice}
            aria-label="공지 닫기"
          >
            <CloseIcon aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
