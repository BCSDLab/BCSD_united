import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from '@tanstack/react-router';

import { cn } from '@bcsdlab/utils';
import type { ShopInfoSummaryResponse } from 'api/storeMobile/entity';
import ImageViewer from 'components/Store/mobile/StoreDetailPage/components/ImageViewer';
import useLogger from 'utils/hooks/analytics/useLogger';
import useBooleanState from 'utils/hooks/state/useBooleanState';

import styles from './ImageCarousel.module.scss';

// KOIN_ORDER_WEBVIEW pages/Shop/components/ImageCarousel 이전.
// 가로 스크롤 스냅 캐러셀(3초 자동 넘김), 이미지를 누르면 전체 화면 뷰어를 연다
interface ImageCarouselProps {
  images: ShopInfoSummaryResponse['images'];
  targetRef: RefObject<HTMLDivElement | null>;
  shopName?: string;
}

const AUTO_SLIDE_INTERVAL = 3000;

export default function ImageCarousel({ images, targetRef, shopName }: ImageCarouselProps) {
  const logger = useLogger();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollIndex, setScrollIndex] = useState(0);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const [isImageViewerOpen, openImageViewer, closeImageViewer] = useBooleanState(false);

  const prevIndexRef = useRef(0);
  // 스크롤 리스너는 마운트 때 한 번 등록되므로 최신 값은 ref로 읽는다
  const isInteractingRef = useRef(false);
  const shopNameRef = useRef(shopName);

  useEffect(() => {
    isInteractingRef.current = isInteracting;
  }, [isInteracting]);

  useEffect(() => {
    shopNameRef.current = shopName;
  }, [shopName]);

  useEffect(() => {
    if (isInteracting || images.length === 0) return undefined;

    const interval = setInterval(() => {
      const container = containerRef.current;
      if (!container) return;

      const nextIndex = (scrollIndex + 1) % images.length;
      container.scrollTo({ left: nextIndex * container.clientWidth, behavior: 'smooth' });
    }, AUTO_SLIDE_INTERVAL);

    return () => clearInterval(interval);
  }, [images.length, isInteracting, scrollIndex]);

  const logSwipe = useCallback(
    (name: string) => {
      logger.actionEventSwipe({
        team: 'BUSINESS',
        event_label: 'shop_picture_swipe',
        value: name,
      });
    },
    [logger],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      const index = Math.round(container.scrollLeft / container.clientWidth);
      setScrollIndex(index);

      const name = shopNameRef.current;
      if (!name) return;

      // 자동 넘김이나 같은 이미지 안에서의 스크롤은 기록하지 않는다
      if (!isInteractingRef.current || index === prevIndexRef.current) {
        prevIndexRef.current = index;

        return;
      }
      prevIndexRef.current = index;

      logSwipe(name);
    };

    const startInteraction = () => setIsInteracting(true);
    const endInteraction = () => setTimeout(() => setIsInteracting(false), 200);

    container.addEventListener('touchstart', startInteraction);
    container.addEventListener('touchend', endInteraction);
    container.addEventListener('mousedown', startInteraction);
    container.addEventListener('mouseup', endInteraction);
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('touchstart', startInteraction);
      container.removeEventListener('touchend', endInteraction);
      container.removeEventListener('mousedown', startInteraction);
      container.removeEventListener('mouseup', endInteraction);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [logSwipe]);

  // 같은 URL의 히스토리 항목으로 뷰어를 열어 브라우저 뒤로가기로 닫을 수 있게 한다.
  useEffect(() => {
    if (!isImageViewerOpen) return undefined;

    router.history.push(router.state.location.href);

    return router.history.subscribe(({ action }) => {
      if (action.type !== 'PUSH' && action.type !== 'REPLACE') {
        closeImageViewer();
      }
    });
  }, [isImageViewerOpen, closeImageViewer, router]);

  return (
    <div className={styles.carousel} ref={targetRef}>
      <div ref={containerRef} className={styles.carousel__track}>
        {images.map((image, index) => (
          <button
            // eslint-disable-next-line react/no-array-index-key -- 같은 주소의 이미지가 여러 장일 수 있어 순서를 키로 쓴다
            key={index}
            type="button"
            className={styles.carousel__slide}
            onClick={() => {
              openImageViewer();
              setSelectedImageIndex(index);
              setIsInteracting(true);
            }}
          >
            {/* KOIN_ORDER_WEBVIEW와 같이 원본 이미지를 크기 조정 없이 요청한다. */}
            <img src={image.image_url} alt={`slide ${index}`} className={styles.carousel__image} />
          </button>
        ))}
      </div>

      <div className={styles.carousel__dots}>
        {images.length > 1 &&
          images.map((image, index) => (
            <div
              // eslint-disable-next-line react/no-array-index-key -- 점은 순서 외에 구분할 값이 없다
              key={index}
              className={cn({
                [styles.carousel__dot]: true,
                [styles['carousel__dot--active']]: scrollIndex === index,
              })}
            />
          ))}
      </div>
      {isImageViewerOpen && (
        <ImageViewer images={images} onClose={closeImageViewer} initialIndex={selectedImageIndex} />
      )}
    </div>
  );
}
