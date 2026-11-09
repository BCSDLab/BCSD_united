import type { MouseEvent, PointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@bcsdlab/utils';

import type { Dining, DiningPlace, DiningType } from 'api/dinings/entity';
import { filterDinings } from 'components/cafeteria/utils/filter';
import { DINING_TYPE_MAP } from 'static/cafeteria';

import styles from './DiningCarousel.module.scss';

interface DiningCarouselProps {
  dinings: Dining[];
  diningType: DiningType;
  dayLabel: string;
  onDiningClick: () => void;
  onPlaceClick: (place: DiningPlace) => void;
}

interface DiningCardProps {
  place: DiningPlace;
  dining: Dining;
  diningType: DiningType;
  onClick: () => void;
  onInteract: () => void;
}

function DiningCard({ place, dining, diningType, onClick, onInteract }: DiningCardProps) {
  return (
    <button
      type="button"
      className={styles['meal-card']}
      onClick={onClick}
      onFocus={(event) => {
        if (event.currentTarget.matches(':focus-visible')) onInteract();
      }}
      onKeyDown={onInteract}
    >
      <div className={styles['meal-card__meta']}>
        <span>{DINING_TYPE_MAP[diningType]}</span>
        <span className={styles['meal-card__details']}>
          {!!dining.price_cash && <span>{`₩${dining.price_cash.toLocaleString('ko-KR')}`}</span>}
          {!!dining.price_cash && !!dining.kcal && <span>·</span>}
          {!!dining.kcal && <strong>{`${dining.kcal}kcal`}</strong>}
        </span>
      </div>
      <div className={styles['meal-card__title-row']}>
        <span className={styles['meal-card__title']}>{place}</span>
        {dining.soldout_at && <span className={styles['meal-card__soldout']}>품절</span>}
      </div>
      <p className={styles['meal-card__menu']}>
        {dining.menu
          .slice(0, 10)
          .map((menuItem) => menuItem.name)
          .join(' · ')}
      </p>
    </button>
  );
}

export default function DiningCarousel({
  dinings,
  diningType,
  dayLabel,
  onDiningClick,
  onPlaceClick,
}: DiningCarouselProps) {
  const [selectedPlace, setSelectedPlace] = useState<DiningPlace>('A코너');
  const [hasPreviousCards, setHasPreviousCards] = useState(false);
  const [hasMoreCards, setHasMoreCards] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);
  const carouselDragRef = useRef<{ pointerId: number; startX: number; scrollLeft: number } | null>(null);
  const didDragRef = useRef(false);
  const isTabScrollRef = useRef(false);

  const availableDinings = useMemo(
    () => filterDinings(dinings, diningType).filter((dining) => dining.menu.length > 0),
    [dinings, diningType],
  );
  const activePlace = availableDinings.some((dining) => dining.place === selectedPlace)
    ? selectedPlace
    : availableDinings[0]?.place;

  const updateCarouselState = useCallback(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    const hasPrevious = carousel.scrollLeft > 1;
    const hasMore = carousel.scrollWidth - carousel.clientWidth - carousel.scrollLeft > 1;
    setHasPreviousCards(hasPrevious);
    setHasMoreCards(hasMore);

    // 코너 탭이나 카드 포커스로 선택한 코너를 자동 스크롤 위치로 덮어쓰지 않는다.
    if (isTabScrollRef.current) return;

    const carouselRect = carousel.getBoundingClientRect();
    const carouselCenter = carouselRect.left + carousel.clientWidth / 2;
    let activeIndex = 0;
    let closestDistance = Infinity;

    Array.from(carousel.children).forEach((card, index) => {
      const cardRect = card.getBoundingClientRect();
      const cardCenter = cardRect.left + cardRect.width / 2;
      const distance = Math.abs(carouselCenter - cardCenter);

      if (distance < closestDistance) {
        activeIndex = index;
        closestDistance = distance;
      }
    });

    if (!hasPrevious) activeIndex = 0;
    else if (!hasMore) activeIndex = carousel.children.length - 1;

    const activeDining = availableDinings[activeIndex];
    if (activeDining) setSelectedPlace(activeDining.place);
  }, [availableDinings]);

  const handleCarouselInteraction = (place?: DiningPlace) => {
    isTabScrollRef.current = place !== undefined;
    if (place) setSelectedPlace(place);
  };

  const handleCarouselPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    isTabScrollRef.current = false;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;

    carouselDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: event.currentTarget.scrollLeft,
    };
    didDragRef.current = false;
    setIsDragging(true);
  };

  const handleCarouselPointerEnd = () => {
    carouselDragRef.current = null;
    setIsDragging(false);
  };

  const handleCarouselPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = carouselDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.buttons !== 1) {
      handleCarouselPointerEnd();

      return;
    }

    const distance = event.clientX - drag.startX;
    if (!didDragRef.current && Math.abs(distance) < 5) return;

    if (!didDragRef.current) {
      event.currentTarget.setPointerCapture(event.pointerId);
      didDragRef.current = true;
    }
    event.preventDefault();
    isTabScrollRef.current = false;
    event.currentTarget.scrollLeft = drag.scrollLeft - distance;
  };

  const handleCarouselClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!didDragRef.current || event.detail === 0) return;

    event.preventDefault();
    event.stopPropagation();
    didDragRef.current = false;
  };

  const handlePlaceClick = (place: DiningPlace) => {
    onPlaceClick(place);
    setSelectedPlace(place);

    const carousel = carouselRef.current;
    const card = carousel?.children[availableDinings.findIndex((dining) => dining.place === place)];
    if (carousel && card) {
      isTabScrollRef.current = true;
      card.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  };

  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    isTabScrollRef.current = false;
    const observer = new ResizeObserver(updateCarouselState);
    observer.observe(carousel);

    return () => observer.disconnect();
  }, [updateCarouselState]);

  const placeTabs = (
    <div className={styles.place}>
      {availableDinings.map(({ place: placeName }) => (
        <button
          type="button"
          key={placeName}
          className={cn({
            [styles.place__name]: true,
            [styles['place__name--selected']]: placeName === activePlace,
          })}
          onClick={() => handlePlaceClick(placeName)}
        >
          {placeName === '2캠퍼스' ? '2캠' : placeName}
        </button>
      ))}
    </div>
  );

  return (
    <div className={styles.card}>
      <div
        className={cn({
          [styles.carousel]: true,
          [styles['carousel--has-previous']]: hasPreviousCards,
          [styles['carousel--has-more']]: hasMoreCards,
        })}
      >
        <div
          ref={carouselRef}
          className={cn({
            [styles.carousel__viewport]: true,
            [styles['carousel__viewport--dragging']]: isDragging,
          })}
          role="group"
          aria-label={`${dayLabel}의 식단 목록`}
          onScroll={updateCarouselState}
          onWheel={() => handleCarouselInteraction()}
          onPointerDown={handleCarouselPointerDown}
          onPointerMove={handleCarouselPointerMove}
          onPointerUp={handleCarouselPointerEnd}
          onPointerCancel={handleCarouselPointerEnd}
          onPointerLeave={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) handleCarouselPointerEnd();
          }}
          onLostPointerCapture={handleCarouselPointerEnd}
          onClickCapture={handleCarouselClickCapture}
        >
          {availableDinings.map((dining) => (
            <DiningCard
              key={dining.place}
              place={dining.place}
              dining={dining}
              diningType={diningType}
              onClick={onDiningClick}
              onInteract={() => handleCarouselInteraction(dining.place)}
            />
          ))}
        </div>
      </div>
      {placeTabs}
    </div>
  );
}
