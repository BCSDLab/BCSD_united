import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@bcsdlab/utils';

import PhotoNextIcon from 'assets/svg/Club/next-image-icon.svg';
import PhotoPreviousIcon from 'assets/svg/Club/pre-image-icon.svg';
import PhotoCloseIcon from 'assets/svg/Team/x-icon.svg';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useArrowKeyNavigation from 'utils/hooks/ui/useArrowKeyNavigation';
import { useBodyScrollLock } from 'utils/hooks/ui/useBodyScrollLock';
import { useEscapeKeyDown } from 'utils/hooks/ui/useEscapeKeyDown';
import useImageSwipe from 'utils/hooks/ui/useImageSwipe';
import { useOutsideClick } from 'utils/hooks/ui/useOutsideClick';
import { createTouchHandlers } from 'utils/ts/touchHandler';

import styles from './ImageModal.module.scss';

export interface ImageModalProps {
  imageList: string[];
  imageIndex: number;
  imageAlt?: string;
  imageTitle?: string;
  dialogLabel?: string;
  imageSize?: 'default' | 'large';
  mobileNavigation?: boolean;
  onClose: () => void;
}

function ImageModal({
  imageList,
  imageIndex,
  imageAlt = '상점이미지',
  imageTitle,
  dialogLabel = '이미지 확대 보기',
  imageSize = 'default',
  mobileNavigation = false,
  onClose,
}: ImageModalProps) {
  const isMobile = useMediaQuery();
  const isMobileNavigation = mobileNavigation && isMobile;
  const isDesktopGallery = imageSize === 'large' && !isMobile;
  const [selectedIndex, setSelectedIndex] = useState(imageIndex);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const startDistanceRef = useRef(0);
  const startTranslateRef = useRef({ x: 0, y: 0 });
  const startTouchRef = useRef<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const mobileContainerRef = useRef<HTMLDivElement | null>(null);

  const navigateImage = useCallback(
    (move: number) => {
      if (isMobileNavigation && scale !== 1) return;
      setSelectedIndex((prevIndex) => {
        const newIndex = prevIndex + move;

        return Math.max(0, Math.min(newIndex, imageList.length - 1));
      });
    },
    [imageList.length, scale, isMobileNavigation],
  );

  const { handlers, onButtonClick } = useImageSwipe({
    enabled: isMobileNavigation && scale === 1,
    onPrevious: () => navigateImage(-1),
    onNext: () => navigateImage(1),
  });

  const { backgroundRef } = useOutsideClick({ onOutsideClick: onClose });
  useEscapeKeyDown({ onEscape: onClose });
  useBodyScrollLock();

  useArrowKeyNavigation({ navigateImage });

  useEffect(() => {
    const imageEl = isMobileNavigation ? mobileContainerRef.current : imageRef.current;
    if (!imageEl) return () => {};

    const { handleTouchStart, handleTouchMove, handleTouchEnd } = createTouchHandlers({
      scale,
      setScale,
      translate,
      setTranslate,
      startDistanceRef,
      startTranslateRef,
      startTouchRef,
    });

    imageEl.addEventListener('touchstart', handleTouchStart, { passive: false });
    imageEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    imageEl.addEventListener('touchend', handleTouchEnd);

    return () => {
      imageEl.removeEventListener('touchstart', handleTouchStart);
      imageEl.removeEventListener('touchmove', handleTouchMove);
      imageEl.removeEventListener('touchend', handleTouchEnd);
    };
  }, [scale, translate, isMobileNavigation, isDesktopGallery]);

  const image = (
    // 이미지마다 크기가 다르고 핀치 줌이 DOM ref를 직접 사용한다.
    <img
      ref={imageRef}
      className={cn({
        [styles.image]: true,
        [styles['image--large']]: imageSize === 'large',
        [styles['desktop-gallery__image']]: isDesktopGallery,
      })}
      src={imageList[selectedIndex]}
      alt={imageAlt}
      draggable={isMobileNavigation ? false : undefined}
      style={{
        transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
      }}
    />
  );

  return (
    <div
      className={cn({
        [styles.background]: true,
        [styles['background--desktop-gallery']]: isDesktopGallery,
      })}
      ref={backgroundRef}
      role={isMobileNavigation || isDesktopGallery ? 'dialog' : undefined}
      aria-modal={isMobileNavigation || isDesktopGallery ? true : undefined}
      aria-label={isMobileNavigation || isDesktopGallery ? dialogLabel : undefined}
    >
      {!isMobileNavigation && !isDesktopGallery && selectedIndex !== 0 && (
        <button
          type="button"
          aria-label="이전 이미지"
          className={cn({
            [styles['arrow-button']]: true,
            [styles['arrow-button--prev']]: true,
          })}
          onClick={() => navigateImage(-1)}
        />
      )}
      {!isMobileNavigation && !isDesktopGallery && selectedIndex !== imageList.length - 1 && (
        <button
          type="button"
          aria-label="다음 이미지"
          className={cn({
            [styles['arrow-button']]: true,
            [styles['arrow-button--next']]: true,
          })}
          onClick={() => navigateImage(1)}
        />
      )}
      {isDesktopGallery && (
        <>
          <div className={styles['desktop-header']}>
            <div className={styles['desktop-header__text']}>
              {imageTitle && <h2 className={styles['desktop-header__title']}>{imageTitle}</h2>}
              <p className={styles['desktop-header__description']}>상세 사진</p>
            </div>
            <button
              type="button"
              className={styles['desktop-header__close']}
              aria-label="이미지 닫기"
              onClick={onClose}
            >
              <PhotoCloseIcon width={40} height={40} aria-hidden />
            </button>
          </div>
          <div className={styles['desktop-gallery']}>
            <div className={styles['desktop-gallery__stage']}>
              {image}
              {imageList.length > 1 && (
                <>
                  <button
                    type="button"
                    className={styles['desktop-gallery__previous']}
                    aria-label="이전 이미지"
                    disabled={selectedIndex === 0}
                    onClick={() => navigateImage(-1)}
                  >
                    <PhotoPreviousIcon aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={styles['desktop-gallery__next']}
                    aria-label="다음 이미지"
                    disabled={selectedIndex === imageList.length - 1}
                    onClick={() => navigateImage(1)}
                  >
                    <PhotoNextIcon aria-hidden />
                  </button>
                </>
              )}
            </div>
            {imageList.length > 1 && (
              <p className={styles['desktop-gallery__count']} aria-live="polite">
                {selectedIndex + 1} / {imageList.length}
              </p>
            )}
          </div>
        </>
      )}
      {isMobileNavigation && (
        <div
          {...handlers}
          ref={(element) => {
            mobileContainerRef.current = element;
            handlers.ref(element);
          }}
          className={styles['mobile-gallery']}
        >
          {image}
          {scale === 1 && imageList.length > 1 && (
            <>
              <button
                type="button"
                className={`${styles['mobile-gallery__tap']} ${styles['mobile-gallery__tap--previous']}`}
                aria-label="이전 건물 사진"
                aria-disabled={selectedIndex === 0}
                onClick={onButtonClick(() => navigateImage(-1))}
              />
              <button
                type="button"
                className={`${styles['mobile-gallery__tap']} ${styles['mobile-gallery__tap--next']}`}
                aria-label="다음 건물 사진"
                aria-disabled={selectedIndex === imageList.length - 1}
                onClick={onButtonClick(() => navigateImage(1))}
              />
            </>
          )}
        </div>
      )}
      {!isDesktopGallery && !isMobileNavigation && image}
      {!isDesktopGallery && (
        <button className={styles.close} type="button" aria-label="이미지 닫기" onClick={() => onClose()} />
      )}
    </div>
  );
}

export default ImageModal;
