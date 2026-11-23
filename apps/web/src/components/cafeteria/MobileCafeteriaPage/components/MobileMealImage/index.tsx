import type { Dining } from 'api/dinings/entity';
import NoMeals from 'assets/svg/no-meals-mobile.svg';
import Image from 'components/ui/Image';

import styles from './MobileMealImage.module.css';

interface MobileMealImageProps {
  dining: Dining;
  handleImageClick: (dining: Dining) => void;
}

export default function MobileMealImage({ dining, handleImageClick }: MobileMealImageProps) {
  const isABC = ['A코너', 'B코너', 'C코너'].includes(dining.place);
  const hasImage = !!dining.image_url;
  const isBreakfast = dining.type === 'BREAKFAST';
  const isBoxVisible = isABC && (!isBreakfast || hasImage);
  if (!isBoxVisible) return null;
  if (!hasImage) return <span className={styles['no-image']}>사진 미등록</span>;

  return (
    <button
      type="button"
      className={styles.image}
      aria-label={`${dining.place} 식단 사진 보기`}
      onClick={() => handleImageClick(dining)}
    >
      {dining.soldout_at && (
        <span className={styles['image--sold-out']}>
          <NoMeals />
          품절된 메뉴입니다.
        </span>
      )}
      <Image
        className={styles.image__img}
        src={dining.image_url!}
        alt={`${dining.place} 식단 사진`}
        width={310}
        height={222}
        sizes="calc(100vw - 66px)"
      />
    </button>
  );
}
