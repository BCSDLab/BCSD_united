import { useRef, useState } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import { Swiper, SwiperSlide } from 'swiper/react';

import useRoomPhotoModal from 'components/Room/RoomDetailPage/hooks/useRoomPhotoModal';
import Image from 'components/ui/Image';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import showToast from 'utils/ts/showToast';

import 'swiper/css';
import styles from './RoomDetailImg.module.scss';

interface RoomDetailImgProps {
  imgUrl: string[];
}

function RoomDetailImg({ imgUrl }: RoomDetailImgProps) {
  const isMobile = useMediaQuery();
  const [imgIndex, setImgIndex] = useState(0);
  const swiperRef = useRef<SwiperInstance | null>(null);
  const logger = useLogger();
  const openRoomPhotoModal = useRoomPhotoModal();
  const logImageSlide = (value: '이전' | '다음') => {
    if (isMobile) {
      logger.actionEventSwipe({
        event_name: 'DA1',
        event_label: 'real_estate__room_detail__photo_view__slide__swipe',
        value,
      });

      return;
    }

    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'real_estate__room_detail__photo_view__slide__click',
      value,
    });
  };
  const previousImage = () => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    if (swiper.isBeginning) {
      if (!isMobile) showToast('info', '첫 이미지입니다.');

      return;
    }
    swiper.slidePrev();
  };
  const nextImage = () => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    if (swiper.isEnd) {
      if (!isMobile) showToast('info', '마지막 이미지입니다.');

      return;
    }
    swiper.slideNext();
  };
  const openImage = () => {
    openRoomPhotoModal({
      imageList: imgUrl,
      imageIndex: imgIndex,
      imageAlt: '건물 사진',
      dialogLabel: '건물 사진 확대 보기',
      mobileNavigation: true,
    });
  };

  return (
    <div className={styles['img-slider']}>
      {!isMobile && (
        <button className={styles['img-slider__img-arrow']} type="button" onClick={previousImage}>
          <Image
            src="https://static.koreatech.in/assets/ic-room/left-arrow.png"
            alt=""
            width={48}
            height={48}
            sizes="48px"
          />
        </button>
      )}
      <div className={styles['img-slider__img']}>
        <Swiper
          className={styles['img-slider__slides']}
          allowTouchMove={isMobile}
          touchEventsTarget="container"
          focusableElements="input, select, option, textarea, video, label"
          onSwiper={(swiper) => {
            swiperRef.current = swiper;
          }}
          onSlideChange={({ activeIndex }) => {
            if (activeIndex === imgIndex) return;
            logImageSlide(activeIndex > imgIndex ? '다음' : '이전');
            setImgIndex(activeIndex);
          }}
        >
          {imgUrl.map((src, index) => (
            // eslint-disable-next-line react/no-array-index-key -- 같은 URL의 사진도 각 순서의 슬라이드로 구분한다.
            <SwiperSlide key={index} aria-hidden={index !== imgIndex}>
              <Image
                className={styles['img-slider__photo']}
                src={src}
                alt="방 사진"
                fill
                sizes={isMobile ? '100vw' : '800px'}
                priority={index === 0}
              />
            </SwiperSlide>
          ))}
          {isMobile && (
            <div slot="container-end">
              {imgUrl.length > 1 && (
                <button
                  type="button"
                  className={`${styles['img-slider__tap']} ${styles['img-slider__tap--previous']}`}
                  aria-label="이전 건물 사진"
                  aria-disabled={imgIndex === 0}
                  onClick={previousImage}
                />
              )}
              <button
                type="button"
                className={`${styles['img-slider__tap']} ${styles['img-slider__tap--center']}`}
                aria-label="건물 사진 크게 보기"
                onClick={openImage}
              />
              {imgUrl.length > 1 && (
                <button
                  type="button"
                  className={`${styles['img-slider__tap']} ${styles['img-slider__tap--next']}`}
                  aria-label="다음 건물 사진"
                  aria-disabled={imgIndex === imgUrl.length - 1}
                  onClick={nextImage}
                />
              )}
            </div>
          )}
        </Swiper>
      </div>
      {!isMobile && (
        <button className={styles['img-slider__img-arrow']} type="button" onClick={nextImage}>
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
