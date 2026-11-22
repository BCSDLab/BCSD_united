import ImageModal from 'components/modal/Modal/ImageModal';
import type { Portal } from 'components/modal/Modal/PortalProvider';
import useClickArrow from 'components/Room/RoomDetailPage/hooks/useClickArrow';
import Image from 'components/ui/Image';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useModalPortal from 'utils/hooks/layout/useModalPortal';
import useImageSwipe from 'utils/hooks/ui/useImageSwipe';

import styles from './RoomDetailImg.module.scss';

interface RoomDetailImgProps {
  imgUrl: string[];
}

function RoomDetailImg({ imgUrl }: RoomDetailImgProps) {
  const isMobile = useMediaQuery();
  const { imgIndex, clickRightArrow, clickLeftArrow } = useClickArrow(imgUrl.length);
  const logger = useLogger();
  const portal = useModalPortal();
  const logImageSlide = (value: '이전' | '다음') => {
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'real_estate__room_detail__photo_view__slide__click',
      value,
    });
  };
  const previousImage = () => {
    if (imgIndex > 0) {
      logImageSlide('이전');
      clickLeftArrow();
    }
  };
  const nextImage = () => {
    if (imgIndex < imgUrl.length - 1) {
      logImageSlide('다음');
      clickRightArrow();
    }
  };
  const openImage = () => {
    portal.open((option: Portal) => (
      <ImageModal
        imageList={imgUrl}
        imageIndex={imgIndex}
        imageAlt="건물 사진"
        mobileNavigation
        onClose={option.close}
      />
    ));
  };
  const { handlers, onKeyboardClick } = useImageSwipe({
    enabled: isMobile,
    onPrevious: previousImage,
    onNext: nextImage,
    onCenterTap: openImage,
  });

  return (
    <div className={styles['img-slider']}>
      {!isMobile && (
        <button
          className={styles['img-slider__img-arrow']}
          type="button"
          onClick={() => {
            logImageSlide('이전');
            clickLeftArrow();
          }}
        >
          <Image
            src="https://static.koreatech.in/assets/ic-room/left-arrow.png"
            alt=""
            width={48}
            height={48}
            sizes="48px"
          />
        </button>
      )}
      <div {...(isMobile ? handlers : {})} className={styles['img-slider__img']}>
        <Image
          className={styles['img-slider__photo']}
          key={imgUrl[imgIndex]}
          src={imgUrl[imgIndex]}
          alt="방 사진"
          fill
          sizes={isMobile ? '100vw' : '800px'}
          priority={imgIndex === 0}
        />
        {isMobile && (
          <>
            {imgUrl.length > 1 && (
              <button
                type="button"
                className={`${styles['img-slider__tap']} ${styles['img-slider__tap--previous']}`}
                aria-label="이전 건물 사진"
                aria-disabled={imgIndex === 0}
                onClick={onKeyboardClick(previousImage)}
              />
            )}
            <button
              type="button"
              className={`${styles['img-slider__tap']} ${styles['img-slider__tap--center']}`}
              aria-label="건물 사진 크게 보기"
              onClick={onKeyboardClick(openImage)}
            />
            {imgUrl.length > 1 && (
              <button
                type="button"
                className={`${styles['img-slider__tap']} ${styles['img-slider__tap--next']}`}
                aria-label="다음 건물 사진"
                aria-disabled={imgIndex === imgUrl.length - 1}
                onClick={onKeyboardClick(nextImage)}
              />
            )}
          </>
        )}
      </div>
      {!isMobile && (
        <button
          className={styles['img-slider__img-arrow']}
          type="button"
          onClick={() => {
            logImageSlide('다음');
            clickRightArrow();
          }}
        >
          <Image
            src="https://static.koreatech.in/assets/ic-room/right-arrow.png"
            alt=""
            width={48}
            height={48}
            sizes="48px"
          />
        </button>
      )}
      {isMobile ? (
        <div className={styles['img-slider__dots']} role="status" aria-label={`${imgIndex + 1} / ${imgUrl.length}`}>
          {imgUrl.length > 1 &&
            imgUrl.map((_, index) => (
              <span
                // eslint-disable-next-line react/no-array-index-key -- 점은 사진의 순서만 나타낸다.
                key={index}
                className={index === imgIndex ? styles['img-slider__dot--active'] : styles['img-slider__dot']}
                aria-hidden
              />
            ))}
        </div>
      ) : (
        <div className={styles['img-slider__index']}>{`${imgIndex + 1} / ${imgUrl.length}`}</div>
      )}
    </div>
  );
}

export default RoomDetailImg;
