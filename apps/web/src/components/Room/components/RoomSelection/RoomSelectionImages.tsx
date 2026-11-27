import { useRef, useState } from 'react';
import type { Swiper as SwiperInstance } from 'swiper';
import { Swiper, SwiperSlide } from 'swiper/react';

import SleepIcon from 'assets/svg/common/sleep-bbico.svg';
import ExpandIcon from 'assets/svg/Room/expand.svg';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';
import useRoomPhotoModal from 'components/Room/RoomDetailPage/hooks/useRoomPhotoModal';
import Image from 'components/ui/Image';
import useLogger from 'utils/hooks/analytics/useLogger';

import 'swiper/css';
import styles from './RoomSelectionImages.module.scss';

interface RoomSelectionImagesProps {
  imageUrls: string[] | null;
  name: string;
}

export default function RoomSelectionImages({ imageUrls, name }: RoomSelectionImagesProps) {
  const images = imageUrls?.filter(Boolean) ?? [];
  const [imageIndex, setImageIndex] = useState(0);
  const swiperRef = useRef<SwiperInstance | null>(null);
  const openRoomPhotoModal = useRoomPhotoModal();
  const logger = useLogger();
  const currentIndex = Math.min(imageIndex, Math.max(0, images.length - 1));

  if (images.length === 0) {
    return (
      <div className={styles.empty}>
        <SleepIcon aria-hidden />
        <p>이미지 준비 중입니다.</p>
      </div>
    );
  }

  const slide = (direction: -1 | 1) => {
    swiperRef.current?.slideTo(currentIndex + direction);
    logger.actionEventClick({
      event_name: 'DA1',
      event_label: 'real_estate__room_detail__photo_view__slide__click',
      value: direction === -1 ? '이전' : '다음',
    });
  };

  const openImage = () => {
    openRoomPhotoModal({
      imageList: images,
      imageIndex: currentIndex,
      imageAlt: `${name} 건물 사진`,
      imageSize: 'large',
      imageTitle: name,
      imageDescription: '상세 사진',
      dialogLabel: '건물 사진 확대 보기',
    });
  };

  return (
    <div className={styles.gallery}>
      <Swiper
        className={styles.slides}
        allowTouchMove={false}
        onSwiper={(swiper) => {
          swiperRef.current = swiper;
        }}
        onSlideChange={({ activeIndex }) => setImageIndex(activeIndex)}
      >
        {images.map((src, index) => (
          // eslint-disable-next-line react/no-array-index-key -- 사진 순서가 고정되어 있고 같은 URL이 중복될 수 있다.
          <SwiperSlide key={index} aria-hidden={index !== currentIndex}>
            <Image className={styles.photo} src={src} alt={`${name} 건물 사진 ${index + 1}`} fill sizes="411px" />
          </SwiperSlide>
        ))}
      </Swiper>
      {images.length > 1 && (
        <>
          <button
            type="button"
            className={`${styles.arrow} ${styles['arrow--previous']}`}
            aria-label="이전 건물 사진"
            disabled={currentIndex === 0}
            onClick={() => slide(-1)}
          >
            <ChevronRightIcon aria-hidden />
          </button>
          <button
            type="button"
            className={`${styles.arrow} ${styles['arrow--next']}`}
            aria-label="다음 건물 사진"
            disabled={currentIndex === images.length - 1}
            onClick={() => slide(1)}
          >
            <ChevronRightIcon aria-hidden />
          </button>
        </>
      )}
      <span className={styles.count} aria-live="polite">
        {currentIndex + 1} / {images.length}
      </span>
      <button type="button" className={styles.expand} onClick={openImage}>
        <ExpandIcon aria-hidden />
        크게 보기
      </button>
    </div>
  );
}
