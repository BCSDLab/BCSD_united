import { Fragment } from 'react';
import { useRouter, useSearch } from '@tanstack/react-router';

import DeliveryIcon from 'assets/svg/Order/Home/delivery-icon.svg';
import StarIcon from 'assets/svg/Store/star-icon.svg';
import { getLoggingTime } from 'components/Store/mobile/common/utils/loggingTime';
import { getCategoryIdFromQuery, getCategoryNameById } from 'components/Store/mobile/common/utils/shopCategories';
import useLogger from 'utils/hooks/analytics/useLogger';
import { isomorphicSessionStorage } from 'utils/ts/env';
import { formatPrice } from 'utils/ts/formatPrice';

import styles from './ShopCard.module.scss';

// KOIN_ORDER_WEBVIEW pages/Home/components/ShopCard 이전. 상점 목록·주문 홈의 가로형 카드.
// 배달비·태그(픽업가능·서비스 증정)는 주문 가능 상점만 넘긴다
interface ShopCardProps {
  shopId: number;
  href: string;
  isOpen: boolean;
  name: string;
  rating: number;
  reviewCount: number;
  thumbnailUrl: string;
  deliveryFee?: number | null;
  tags?: string[];
}

export default function ShopCard({
  shopId,
  href,
  isOpen,
  name,
  rating,
  reviewCount,
  thumbnailUrl,
  deliveryFee,
  tags = [],
}: ShopCardProps) {
  const router = useRouter();
  const routeSearch = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const logger = useLogger();

  const handleShopCardClick = () => {
    const categoryName = getCategoryNameById(getCategoryIdFromQuery(routeSearch.category));
    logger.actionEventClick({
      team: 'BUSINESS',
      event_label: 'shop_click',
      value: `${name}`,
      duration_time: getLoggingTime('selectedCategoryTime'),
      previous_page: categoryName,
      current_page: `${name}`,
    });
    isomorphicSessionStorage.setItem('currentCategory', categoryName);
    router.navigate({ href: href });
  };

  return (
    <button type="button" onClick={handleShopCardClick} data-testid={`shopCard-${shopId}`} className={styles.card}>
      {!isOpen && (
        <div className={styles.card__closed}>
          <div className={styles['card__closed-text']}>영업이 종료된 가게에요!</div>
        </div>
      )}

      {thumbnailUrl ? (
        // KOIN_ORDER_WEBVIEW와 같이 원본 이미지를 크기 조정 없이 요청한다.
        <img src={thumbnailUrl} alt={name} className={styles.card__thumbnail} />
      ) : (
        <div className={styles.card__placeholder}>이미지 준비중</div>
      )}

      <div className={styles.card__info}>
        <div className={styles.card__name} data-testid={`shopName-${shopId}`}>
          {name}
        </div>

        <div className={styles.card__rating}>
          <div className={styles['card__rating-score']}>
            <StarIcon fill="#ffc62b" className={styles.card__star} />
            <div>{rating}</div>
          </div>
          <div className={styles['card__review-count']} data-testid={`reviewCount-${shopId}`}>
            ( 리뷰 {reviewCount}개 )
          </div>
        </div>

        {!!deliveryFee && (
          <div className={styles.card__delivery}>
            <DeliveryIcon fill="#c358fc" />
            <div>배달비 {formatPrice(deliveryFee)}</div>
          </div>
        )}

        <div className={styles.card__tags}>
          {tags.map((tag, index) => (
            <Fragment key={tag}>
              {index > 0 && '  |  '}
              <span className={styles.card__tag}>{tag}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </button>
  );
}
