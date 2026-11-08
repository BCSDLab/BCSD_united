import { useEffect, useState } from 'react';
import { cn } from '@bcsdlab/utils';
import { useRouter } from '@tanstack/react-router';

import type { DiningPlace } from 'api/dinings/entity';
import BubbleTailBottom from 'assets/svg/bubble-tail-bottom.svg';
import Close from 'assets/svg/close-icon-grey.svg';
import NotServed from 'assets/svg/not-served.svg';
import RightArrow from 'assets/svg/right-arrow.svg';
import useDinings from 'components/cafeteria/hooks/useDinings';
import type { ServerDining } from 'components/IndexComponents/HomePage/types';
import { DINING_TYPE_MAP, PLACE_ORDER } from 'static/cafeteria';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import { isomorphicLocalStorage } from 'utils/ts/env';

import styles from './IndexCafeteria.module.scss';

type MealClickTarget = '전체보기' | '카드' | '제목';

interface IndexCafeteriaProps {
  serverDining: ServerDining;
}

/**
 * 시각 파생 값은 서버가 확정한 것을 쓴다. `useMount()` 뒤로 미루면 React 경고는 사라지지만
 * 서버가 그린 DOM이 하이드레이션 직후 매번 교체된다.
 */
function IndexCafeteria({ serverDining }: IndexCafeteriaProps) {
  const router = useRouter();
  const isMobile = useMediaQuery();
  const logger = useLogger();
  const { dinings } = useDinings(new Date(serverDining.date));

  const diningType = serverDining.type;
  const dayLabel = serverDining.dayLabel;

  const [selectedPlace, setSelectedPlace] = useState<DiningPlace>('A코너');
  const [isTooltipOpen, openTooltip, closeTooltip] = useBooleanState(false);

  const selectedDining = dinings.find((dining) => dining.place === selectedPlace && dining.type === diningType);

  // 홈 1-3 메인 식단 진입: 제목·더보기·카드 본문 모두 같은 계약, value는 {식사시간}_{클릭대상} (더보기는 전체보기로 기록)
  const handleMealClick = (target: MealClickTarget) => {
    logger.actionEventClick({
      event_name: 'DA2',
      event_label: 'main__main__meal__click',
      value: `${diningType ? DINING_TYPE_MAP[diningType] : ''}_${target}`,
    });
    router.navigate({ href: ROUTES.Cafeteria() });
  };

  const handlePlaceClick = (place: DiningPlace) => {
    // 홈 1-4 식단 코너 클릭 (식단 1-3~1-7은 1-1에 따라 레거시)
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'main__main__corner__select',
      value: place,
      event_category: 'select',
    });
    setSelectedPlace(place);
  };

  const handleTooltipContentButtonClick = () => {
    isomorphicLocalStorage.setItem('cafeteria-tooltip', 'used');
    handleMealClick('전체보기');
  };

  const handleTooltipCloseButtonClick = () => {
    isomorphicLocalStorage.setItem('cafeteria-tooltip', 'used');
    closeTooltip();
  };

  useEffect(() => {
    if (isomorphicLocalStorage.getItem('cafeteria-tooltip') === null) {
      openTooltip();
    }
  }, [openTooltip]);

  return (
    <section className={styles.template}>
      <h2 className={styles.header}>
        <button type="button" className={styles.header__title} onClick={() => handleMealClick('제목')}>
          {`${dayLabel} 식단`}
        </button>
        <button type="button" className={styles.header__more} onClick={() => handleMealClick('전체보기')}>
          더보기
          <RightArrow />
        </button>
        {isTooltipOpen && (
          <div className={styles.header__tooltip}>
            <button
              type="button"
              className={styles['header__tooltip-content']}
              onClick={handleTooltipContentButtonClick}
            >
              식단 사진 기능이 생겼어요!
              <br />
              오늘의 식단을 확인해보세요.
            </button>

            <button
              type="button"
              aria-label="close"
              className={styles['header__tooltip-close']}
              onClick={handleTooltipCloseButtonClick}
            >
              <Close />
            </button>
            <div className={styles['header__tooltip-asset']}>
              <BubbleTailBottom />
            </div>
          </div>
        )}
      </h2>

      <div className={styles.card}>
        <div className={styles.place}>
          {PLACE_ORDER.map((placeName) => (
            <button
              type="button"
              key={placeName}
              className={cn({
                [styles.place__name]: true,
                [styles['place__name--selected']]: placeName === selectedPlace,
              })}
              onClick={() => handlePlaceClick(placeName)}
            >
              {placeName === '2캠퍼스' ? '2캠' : placeName}
            </button>
          ))}
        </div>
        <div className={styles.type}>{diningType ? DINING_TYPE_MAP[diningType] : ''}</div>
        <button
          type="button"
          className={cn({
            [styles.menus]: true,
            [styles['menus--not-served']]: !selectedDining,
          })}
          onClick={() => handleMealClick('카드')}
        >
          {isMobile && (
            <div className={styles.menus__type}>
              {diningType ? DINING_TYPE_MAP[diningType] : ''}
              {selectedDining?.soldout_at && <span className={styles.menus__chip}>품절</span>}
            </div>
          )}
          {selectedDining ? (
            <ul className={styles.menus__list}>
              {selectedDining.menu.slice(0, 10).map((menuItem) => (
                <li className={styles.menus__name} key={menuItem.id}>
                  {menuItem.name}
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles['menus__not-served']}>
              <NotServed />
              <p>식단이 제공되지 않아</p>
              <p>표시할 수 없습니다.</p>
            </div>
          )}
        </button>
      </div>
    </section>
  );
}

export default IndexCafeteria;
