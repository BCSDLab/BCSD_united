import { createContext, useContext } from 'react';
import { useLocation } from '@tanstack/react-router';

import BusStopIcon from 'assets/svg/Bus/bus-stop-icon.svg';
import BusTabs from 'components/Bus/BusCoursePage/components/BusTabs';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import styles from './BusCoursePage.module.scss';

const MOBILE_TIMETABLE_TITLES: Record<string, string> = {
  [ROUTES.BusCourseShuttle()]: '셔틀버스 시간표',
  [ROUTES.BusCourseExpress()]: '대성고속 시간표',
  [ROUTES.BusCourseCity()]: '시내버스 시간표',
};

export const BusCourseContext = createContext<{ isMobile: boolean }>({
  isMobile: false,
});

export const useBusCourse = () => useContext(BusCourseContext);

interface BusCoursePageProps {
  children: React.ReactNode;
  boardingLocation?: string;
}

export default function BusCoursePage({ children, boardingLocation }: BusCoursePageProps) {
  const routeLocation = useLocation();
  const isMobile = useMediaQuery();

  const mobileTitle = MOBILE_TIMETABLE_TITLES[routeLocation.pathname] ?? '셔틀버스 시간표';

  return (
    <>
      <MobilePageHeader title="버스 시간표" />
      <main className={styles['root-container']}>
        <div className={styles.container}>
          <header className={styles['mobile-guide']}>
            <div className={styles['mobile-guide__title']}>
              <span>{mobileTitle}</span>
              {boardingLocation && (
                <span className={styles['mobile-guide__boarding']}>
                  {boardingLocation} 승차
                  <BusStopIcon aria-hidden="true" />
                </span>
              )}
            </div>
          </header>
          <header className={styles.guide}>
            <h1 className={styles.guide__title}>버스 시간표</h1>
            <div className={styles.guide__subtitle}>
              어디를 가시나요?
              <br />
              운행수단별로 간단히 비교해드립니다.
            </div>
          </header>

          <BusCourseContext.Provider value={{ isMobile }}>
            <BusTabs />
            <div className={styles.contents}>{children}</div>
          </BusCourseContext.Provider>
        </div>
      </main>
    </>
  );
}
