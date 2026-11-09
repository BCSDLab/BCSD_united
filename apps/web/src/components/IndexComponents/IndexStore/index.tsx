import { Suspense, useEffect } from 'react';
import { Link } from '@tanstack/react-router';

import ErrorBoundary from 'components/boundary/ErrorBoundary';
import { getMainDurationTime, initializeMainEntryTime } from 'components/Store/utils/durationTime';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import { parseSearch } from 'utils/routing/search';

import StoreCard from './StoreCard';
import styles from './IndexStore.module.scss';
import cardStyles from './StoreCard.module.scss';

export default function IndexStore() {
  const logger = useLogger();
  const titleLink = `${ROUTES.Store()}?category=1`;

  useEffect(() => {
    initializeMainEntryTime();
  }, []);

  return (
    <section className={styles.template}>
      <Link
        to={titleLink.split('?')[0]}
        search={parseSearch(titleLink.split('?')[1] ?? '')}
        className={styles.template__title}
        onClick={() =>
          logger.actionEventClick({
            event_name: 'DA2',
            event_label: 'main__main__shop_entry__main_entry__click',
            value: '주변상점',
          })
        }
      >
        주변 상점
      </Link>
      <ErrorBoundary fallbackClassName={cardStyles['store-card']}>
        <Suspense
          fallback={
            <div className={cardStyles['store-card']} role="status">
              상점 정보를 불러오는 중입니다.
            </div>
          }
        >
          <StoreCard
            href={titleLink}
            onClick={() =>
              logger.actionEventClick({
                event_name: 'DA1',
                event_label: 'shop__main__shop_entry__popular_entry__click',
                value: '많이 찾는 상점 둘러보기',
                duration_time: getMainDurationTime(),
              })
            }
          />
        </Suspense>
      </ErrorBoundary>
    </section>
  );
}
