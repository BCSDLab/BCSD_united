import type { ReactNode } from 'react';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { callvanQueries } from 'api/callvan/queries';
import { storeQueries } from 'api/store/queries';
import { weatherQueries } from 'api/weather/queries';
import ArrowRightIcon from 'assets/svg/common/arrow-right-icon.svg';
import BusTimeIcon from 'assets/svg/common/bus-time-icon.svg';
import ForkKnifeIcon from 'assets/svg/common/fork-knife-icon.svg';
import QRCodeIcon from 'assets/svg/common/qr-code-icon.svg';
import BusRouteIcon from 'assets/svg/common/route-icon.svg';
import VanIcon from 'assets/svg/common/van-icon.svg';
import { DiningTime } from 'components/cafeteria/utils/time';
import IndexMobileCafeteria from 'components/IndexComponents/IndexMobileCafeteria';
import IconBox from 'components/ui/IconBox';
import Image from 'components/ui/Image';
import type { LoggingEventName, NamingRuleEventLabel } from 'lib/gtag';
import { BUS_LINKS } from 'static/bus';
import { DINING_TYPE_MAP } from 'static/cafeteria';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import { useUser } from 'utils/hooks/state/useUser';
import { parseSearch } from 'utils/routing/search';
import { useServerNow } from 'utils/ssr/useServerNow';

import styles from './MobileHomeRedesign.module.scss';

const unibus = BUS_LINKS[2];
const mobileStoreLink = `${ROUTES.Store()}?category=1`;
const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
  timeZone: 'Asia/Seoul',
});

const transportCards = [
  {
    href: ROUTES.BusCourseShuttle(),
    title: '버스 시간표',
    description: '노선 별 출발 시간',
    Icon: BusTimeIcon,
    logging: {
      event_label: 'main__main__bus_entry__timetable_entry__click' as const,
      value: '버스 시간표',
    },
  },
  {
    href: ROUTES.BusRoute(),
    title: '버스 노선 조회',
    description: '가장 빠른 버스 찾기',
    Icon: BusRouteIcon,
    logging: {
      event_label: 'main__main__bus_entry__search_entry__click' as const,
      value: '버스 노선 조회',
    },
  },
];

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
  const serverNow = useServerNow();
  const { data: userInfo } = useUser();
  const weatherQuery = useQuery(weatherQueries.info());
  const { data: callvanData } = useSuspenseQuery({
    ...callvanQueries.list({
      statuses: ['RECRUITING'],
      sort: 'LATEST_DESC',
      page: 1,
      limit: 1,
    }),
  });
  const { data: storeCounts } = useSuspenseQuery(storeQueries.counts());
  const { data: storeEventCount } = useSuspenseQuery(storeQueries.eventCount());

  const displayName = userInfo?.nickname?.trim() || userInfo?.name?.trim() || '코리';
  const todayLabel = dateFormatter.format(serverNow);

  // 로깅 네이밍룰 v1.0 · Notion 홈화면 리디자인 명세
  const logClick = (event_label: NamingRuleEventLabel, value: string, event_name: LoggingEventName = 'DA1') => {
    logger.actionEventClick({ event_name, event_label, value });
  };

  return (
    <main className={styles.template}>
      <section className={styles.hero} aria-labelledby="home-greeting-title">
        <div className={styles.hero__meta}>
          <span className={styles.hero__date}>{todayLabel}</span>
          <span className={styles.weather}>
            {weatherQuery.data ? (
              <>
                <Image
                  className={styles.weather__icon}
                  src={weatherQuery.data.weather_icon_url}
                  alt=""
                  width={16}
                  height={16}
                  aria-hidden
                />
                <span className={styles.weather__text}>
                  {weatherQuery.data.weather} {weatherQuery.data.temperature}°
                </span>
              </>
            ) : (
              <span className={styles.weather__text}>
                {weatherQuery.isPending ? '날씨 확인 중' : '날씨 정보 제공 불가'}
              </span>
            )}
          </span>
        </div>
        <h1 id="home-greeting-title" className={styles.hero__title}>
          <span>{displayName}님,</span>
          <span>오늘도 잘 챙겨먹어요</span>
        </h1>
      </section>

      <section className={styles.section} aria-labelledby="today-menu-title">
        <SectionHeader titleId="today-menu-title" title="오늘의 식단">
          <Link
            to={ROUTES.Cafeteria()}
            className={styles['section-link']}
            onClick={() => logClick('main__main__more__click', `${DINING_TYPE_MAP[new DiningTime().getType()]}_더보기`)}
          >
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
            onClick={() => logClick('main__main__bus_entry__ticket_entry__click', '셔틀 탑승권')}
          >
            <span className={styles['ticket-card__text']}>
              <strong>셔틀 탑승권</strong>
              <span>QR 조회</span>
            </span>
            <QRCodeIcon aria-hidden />
          </a>
        </SectionHeader>

        <Link
          to={ROUTES.Callvan()}
          className={styles['callvan-card']}
          onClick={() =>
            logger.actionEventClick({ team: 'CAMPUS', event_label: 'callvanpot', value: '콜밴팟 모집보기' })
          }
        >
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
          {transportCards.map(({ href, title, description, Icon, logging }) => (
            <Link
              to={href.split('?')[0]}
              search={parseSearch(href.split('?')[1] ?? '')}
              className={styles['transport-card']}
              key={href}
              onClick={() => logClick(logging.event_label, logging.value)}
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
            onClick={() => logClick('main__main__shop_entry__main_entry__click', '주변상점')}
          >
            <span>전체보기</span>
            <ArrowRightIcon aria-hidden />
          </Link>
        </SectionHeader>

        <Link
          to={mobileStoreLink.split('?')[0]}
          search={parseSearch(mobileStoreLink.split('?')[1] ?? '')}
          className={styles['store-card']}
          onClick={() => logClick('shop__main__shop_entry__popular_entry__click', '많이 찾는 상점 둘러보기', 'DA2')}
        >
          <div className={styles['store-card__content-wrapper']}>
            <IconBox>
              <ForkKnifeIcon />
            </IconBox>
            <span className={styles['store-card__content']}>
              <span className={styles['store-card__badge']}>KOIN 전용 이벤트 {storeEventCount.count}곳</span>
              <span className={styles['store-card__title']}>
                많이 찾는 상점
                <br />
                둘러보기
              </span>
              <span className={styles['store-card__meta']}>
                영업중 <span className={styles['store-card__count']}>{storeCounts.open_count}곳</span> | 전체{' '}
                {storeCounts.total_count}곳
              </span>
            </span>
          </div>
          <ArrowRightIcon className={styles['store-card__arrow']} aria-hidden />
        </Link>
      </section>
    </main>
  );
}

export default MobileHomeRedesign;
