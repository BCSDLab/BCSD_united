import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@bcsdlab/utils';

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
  imageSize?: 'default' | 'large';
  mobileNavigation?: boolean;
  onClose: () => void;
}

function ImageModal({
  imageList,
  imageIndex,
  imageAlt = '상점이미지',
  imageSize = 'default',
  mobileNavigation = false,
  onClose,
}: ImageModalProps) {
  const isMobile = useMediaQuery();
  const isMobileNavigation = mobileNavigation && isMobile;
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

  const { handlers, onKeyboardClick } = useImageSwipe({
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
  }, [scale, translate, isMobileNavigation]);

  const image = (
    // 이미지마다 크기가 다르고 핀치 줌이 DOM ref를 직접 사용한다.
    <img
      ref={imageRef}
      className={cn({
        [styles.image]: true,
        [styles['image--large']]: imageSize === 'large',
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
      className={styles.background}
      ref={backgroundRef}
      role={isMobileNavigation ? 'dialog' : undefined}
      aria-modal={isMobileNavigation ? true : undefined}
      aria-label={isMobileNavigation ? '건물 사진 확대 보기' : undefined}
    >
      {!isMobileNavigation && selectedIndex !== 0 && (
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
      {!isMobileNavigation && selectedIndex !== imageList.length - 1 && (
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
      {isMobileNavigation ? (
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
                onClick={onKeyboardClick(() => navigateImage(-1))}
              />
              <button
                type="button"
                className={`${styles['mobile-gallery__tap']} ${styles['mobile-gallery__tap--next']}`}
                aria-label="다음 건물 사진"
                aria-disabled={selectedIndex === imageList.length - 1}
                onClick={onKeyboardClick(() => navigateImage(1))}
              />
            </>
          )}
        </div>
      ) : (
        image
      )}
      <button className={styles.close} type="button" aria-label="이미지 닫기" onClick={() => onClose()} />
    </div>
  );
}

export default ImageModal;
