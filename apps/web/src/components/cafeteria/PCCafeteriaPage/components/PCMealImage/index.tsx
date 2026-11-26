import type { Dining } from 'api/dinings/entity';
import NoMeals from 'assets/svg/no-meals-pc.svg';
import Image from 'components/ui/Image';

import styles from './PCMealImage.module.css';

interface PCMealImageProps {
  dining: Dining;
  isThisWeek: boolean;
  handleImageClick: (dining: Dining) => void;
}

export default function PCMealImage({ dining, isThisWeek, handleImageClick }: PCMealImageProps) {
  const isABC = ['A코너', 'B코너', 'C코너'].includes(dining.place);
  const hasImage = !!dining.image_url;
  const isBreakfast = dining.type === 'BREAKFAST';
  const isBoxVisible = isThisWeek && isABC && (!isBreakfast || hasImage);
  if (!isBoxVisible) return null;
  if (!hasImage) return <span className={styles['photo-status']}>사진 미등록</span>;

  return (
    <button
      type="button"
      className={styles.image}
      aria-label={`${dining.place} 식단 사진 크게 보기`}
      onClick={() => handleImageClick(dining)}
    >
      {dining.soldout_at && (
        <span className={styles['image--sold-out']}>
          <NoMeals />
          품절된 메뉴입니다.
        </span>
      )}
      <Image
        src={dining.image_url!}
        alt={`${dining.place} 식단`}
        width={252}
        height={158}
        sizes="(max-width: 1184px) 30vw, 318px"
        className={styles.image__img}
      />
    </button>
  );
}
