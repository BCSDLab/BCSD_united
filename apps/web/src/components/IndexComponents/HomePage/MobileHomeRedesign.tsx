import { Suspense, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { callvanQueries } from 'api/callvan/queries';
import ArrowRightIcon from 'assets/svg/common/arrow-right-icon.svg';
import BusTimeIcon from 'assets/svg/common/bus-time-icon.svg';
import QRCodeIcon from 'assets/svg/common/qr-code-icon.svg';
import BusRouteIcon from 'assets/svg/common/route-icon.svg';
import VanIcon from 'assets/svg/common/van-icon.svg';
import ErrorBoundary from 'components/boundary/ErrorBoundary';
import IndexMobileCafeteria from 'components/IndexComponents/IndexMobileCafeteria';
import StoreCard from 'components/IndexComponents/IndexStore/StoreCard';
import IconBox from 'components/ui/IconBox';
import { BUS_LINKS } from 'static/bus';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import { parseSearch } from 'utils/routing/search';

import HomeGreeting from './HomeGreeting';
import cardStyles from 'components/IndexComponents/IndexStore/StoreCard.module.scss';
import styles from './MobileHomeRedesign.module.scss';

const unibus = BUS_LINKS[2];
const mobileStoreLink = `${ROUTES.Store()}?category=1`;

const MOBILE_HOME_CLICK_VALUES = {
  today_meal: '전체보기',
  shuttle_ticket: '셔틀 탑승권',
  callvanpot: '콜밴팟 모집보기',
  bus_timetable: '버스 시간표 조회하기',
  bus_route: '버스 노선 조회하기',
  shop: '전체보기',
  popular_shop: '많이 찾는 상점 둘러보기',
} as const;

const transportCards = [
  {
    href: ROUTES.BusCourseShuttle(),
    title: '버스 시간표',
    description: '노선 별 출발 시간',
    Icon: BusTimeIcon,
    loggingKey: 'bus_timetable',
  },
  {
    href: ROUTES.BusRoute(),
    title: '버스 노선 조회',
    description: '가장 빠른 버스 찾기',
    Icon: BusRouteIcon,
    loggingKey: 'bus_route',
  },
] as const;

interface SectionHeaderProps {
  titleId: string;
  title: string;
  children: ReactNode;
}

function SectionHeader({ titleId, title, children }: SectionHeaderProps) {
  return (
    <div className={styles.section__header}>
      <h2 id={titleId} className={styles.section__title}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function MobileHomeRedesign() {
  const logger = useLogger();
  const { data: callvanData } = useSuspenseQuery({
    ...callvanQueries.list({
      statuses: ['RECRUITING'],
      sort: 'LATEST_DESC',
      page: 1,
      limit: 1,
    }),
  });

  const logClick = (event_label: keyof typeof MOBILE_HOME_CLICK_VALUES) => {
    logger.actionEventClick({
      team: 'CAMPUS',
      event_label,
      value: MOBILE_HOME_CLICK_VALUES[event_label],
    });
  };

  return (
    <main className={styles.template}>
      <HomeGreeting />

      <section className={styles.section} aria-labelledby="today-menu-title">
        <SectionHeader titleId="today-menu-title" title="오늘의 식단">
          <Link to={ROUTES.Cafeteria()} className={styles['section-link']} onClick={() => logClick('today_meal')}>
            <span>전체보기</span>
            <ArrowRightIcon aria-hidden />
          </Link>
        </SectionHeader>

        <IndexMobileCafeteria />
      </section>

      <section className={styles.section} aria-labelledby="transport-title">
        <SectionHeader titleId="transport-title" title="교통">
          <a
            href={unibus.link}
            className={styles['ticket-card']}
            target="_blank"
            rel="noreferrer"
            onClick={() => logClick('shuttle_ticket')}
          >
            <span className={styles['ticket-card__text']}>
              <strong>셔틀 탑승권</strong>
              <span>QR 조회</span>
            </span>
            <QRCodeIcon aria-hidden />
          </a>
        </SectionHeader>

        <Link to={ROUTES.Callvan()} className={styles['callvan-card']} onClick={() => logClick('callvanpot')}>
          <IconBox className={styles['callvan-card__icon']}>
            <VanIcon />
          </IconBox>
          <span className={styles['callvan-card__content']}>
            <span className={styles['callvan-card__title-row']}>
              <span className={styles['callvan-card__title']}>콜밴팟</span>
              <span className={styles['callvan-card__badge']}>{callvanData.total_count}건 모집중</span>
            </span>
            <span className={styles['callvan-card__description']}>같이 콜밴 탈 사람을 찾아요</span>
          </span>
          <span className={styles['callvan-card__action']}>모집 보기</span>
        </Link>

        <div className={styles['transport-grid']}>
          {transportCards.map(({ href, title, description, Icon, loggingKey }) => (
            <Link
              to={href.split('?')[0]}
              search={parseSearch(href.split('?')[1] ?? '')}
              className={styles['transport-card']}
              key={href}
              onClick={() => logClick(loggingKey)}
            >
              <IconBox>
                <Icon />
              </IconBox>
              <span className={styles['transport-card__content']}>
                <span className={styles['transport-card__title']}>{title}</span>
                <span className={styles['transport-card__description']}>{description}</span>
              </span>
              <span className={styles['transport-card__action']}>조회하기 →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="nearby-store-title">
        <SectionHeader titleId="nearby-store-title" title="주변 상점">
          <Link
            to={mobileStoreLink.split('?')[0]}
            search={parseSearch(mobileStoreLink.split('?')[1] ?? '')}
            className={styles['section-link']}
            onClick={() => logClick('shop')}
          >
            <span>전체보기</span>
            <ArrowRightIcon aria-hidden />
          </Link>
        </SectionHeader>

        <ErrorBoundary fallbackClassName={cardStyles['store-card']}>
          <Suspense
            fallback={
              <div className={cardStyles['store-card']} role="status">
                상점 정보를 불러오는 중입니다.
              </div>
            }
          >
            <StoreCard href={mobileStoreLink} onClick={() => logClick('popular_shop')} />
          </Suspense>
        </ErrorBoundary>
      </section>
    </main>
  );
}

export default MobileHomeRedesign;
