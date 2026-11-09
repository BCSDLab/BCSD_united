import useClickArrow from 'components/Room/RoomDetailPage/hooks/useClickArrow';
import Image from 'components/ui/Image';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import styles from './RoomDetailImg.module.scss';

interface RoomDetailImgProps {
  imgUrl: string[];
}

function RoomDetailImg({ imgUrl }: RoomDetailImgProps) {
  const isMobile = useMediaQuery();
  const { imgIndex, clickRightArrow, clickLeftArrow } = useClickArrow(imgUrl.length);
  const logger = useLogger();

  return (
    <div className={styles['img-slider']}>
      <button
        className={styles['img-slider__img-arrow']}
        type="button"
        onClick={() => {
          logger.actionEventClick({
            event_name: 'DA1',
            event_label: 'real_estate__room_detail__photo_view__slide__click',
            value: '이전',
          });
          clickLeftArrow();
        }}
      >
        <Image
          src="https://static.koreatech.in/assets/ic-room/left-arrow.png"
          alt=""
          width={isMobile ? 40 : 48}
          height={isMobile ? 40 : 48}
          sizes="48px"
        />
      </button>
      <div className={styles['img-slider__img']}>
        <Image
          className={styles['img-slider__photo']}
          key={imgUrl[imgIndex]}
          src={imgUrl[imgIndex]}
          alt="방 사진"
          fill
          sizes={isMobile ? '100vw' : '800px'}
          priority={imgIndex === 0}
        />
      </div>
      <button
        className={styles['img-slider__img-arrow']}
        type="button"
        onClick={() => {
          logger.actionEventClick({
            event_name: 'DA1',
            event_label: 'real_estate__room_detail__photo_view__slide__click',
            value: '다음',
          });
          clickRightArrow();
        }}
      >
        <Image
          src="https://static.koreatech.in/assets/ic-room/right-arrow.png"
          alt=""
          width={isMobile ? 40 : 48}
          height={isMobile ? 40 : 48}
          sizes="48px"
        />
      </button>
      <div className={styles['img-slider__index']}>{`${imgIndex + 1} / ${imgUrl.length}`}</div>
    </div>
  );
}

export default RoomDetailImg;
