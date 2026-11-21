import { cn } from '@bcsdlab/utils';
import { useRouter } from '@tanstack/react-router';

import type { DiningType } from 'api/dinings/entity';
import ArrowBackNewIcon from 'assets/svg/arrow-back-new.svg';
import StoreCtaIcon from 'assets/svg/Store/store-cta-icon.svg';
import { useCafeteriaLiveNow } from 'components/cafeteria/hooks/useCafeteriaLiveNow';
import { useCafeteriaParams } from 'components/cafeteria/hooks/useCafeteriaParams';
import Suspense from 'components/ssr/SSRSuspense';
import { DAYS, DINING_TYPES, DINING_TYPE_MAP } from 'static/cafeteria';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import { useSessionLogger } from 'utils/hooks/analytics/useSessionLogger';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { kstDateKey, kstDayOfWeek } from 'utils/ts/calendar';

import DateNavigator from './components/DateNavigator';
import PCDiningBlocks from './components/PCDiningBlocks';
import styles from './PCCafeteriaPage.module.css';

const getWeekAgo = (now: Date) => {
  const twoWeeksAgoSunday = new Date(`${kstDateKey(now)}T00:00:00Z`);
  twoWeeksAgoSunday.setUTCDate(twoWeeksAgoSunday.getUTCDate() - kstDayOfWeek(twoWeeksAgoSunday) - 8);

  return twoWeeksAgoSunday;
};

function PCCafeteriaComponent() {
  const { date, diningType, setDiningType } = useCafeteriaParams();
  const today = useCafeteriaLiveNow();
  const logger = useLogger();
  const router = useRouter();
  const sessionLogger = useSessionLogger();

  const handleDiningTypeChange = (value: DiningType) => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'cafeteria__cafeteria__meal_time__select',
      value: DINING_TYPE_MAP[value],
      event_category: 'select',
    });
    setDiningType(value);
  };

  const handleDiningToStore = () => {
    sessionLogger.actionSessionEvent({
      event_label: 'dining_to_shop',
      value: DINING_TYPE_MAP[diningType],
      session_name: 'dining2shop',
      session_lifetime_minutes: 30,
    });
    router.navigate({ href: ROUTES.Store() });
  };

  const 지난주일요일 = getWeekAgo(today);
  const isThisWeek = 지난주일요일 < date.current();

  const formatDiningDate = () => {
    if (date.checkToday(date.current())) {
      return '오늘';
    }

    if (date.checkTomorrow(date.current())) {
      return '내일';
    }

    return DAYS[kstDayOfWeek(date.current())];
  };

  useScrollToTop();

  return (
    <div className={styles.container}>
      <div className={styles['type-selector']}>
        <h1>{formatDiningDate()}의 식단</h1>
        <div className={styles['meal-tabs']} role="group" aria-label="끼니 선택">
          {DINING_TYPES.map((type: DiningType) => (
            <button
              key={type}
              className={cn({
                [styles['meal-tabs__button']]: true,
                [styles['meal-tabs__button--selected']]: diningType === type,
              })}
              type="button"
              aria-pressed={diningType === type}
              onClick={() => handleDiningTypeChange(type)}
            >
              {DINING_TYPE_MAP[type]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <DateNavigator />
      </div>
      <>
        <button type="button" className={styles['recommend-banner']} onClick={handleDiningToStore}>
          <div className={styles['recommend-banner__left']}>
            <StoreCtaIcon />
            <p className={styles['recommend-banner__text-left']}>오늘의 학식이 별로라면?</p>
          </div>
          <div className={styles['recommend-banner__right']}>
            <p className={styles['recommend-banner__text-right']}>내 주변 음식점 보기</p>
            <ArrowBackNewIcon className={styles['recommend-banner__arrow']} />
          </div>
        </button>
      </>
      <div>
        <Suspense fallback={<div />}>
          <PCDiningBlocks diningType={diningType} isThisWeek={isThisWeek} />
        </Suspense>
        <span className={styles['pc-menu-blocks__caution']}>식단 정보는 운영 상황에 따라 변동될 수 있습니다.</span>
      </div>
    </div>
  );
}

export default function PCCafeteriaPage() {
  return (
    <Suspense fallback={<div />}>
      <PCCafeteriaComponent />
    </Suspense>
  );
}
