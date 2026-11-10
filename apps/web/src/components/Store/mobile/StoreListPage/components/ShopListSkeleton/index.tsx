import styles from './ShopListSkeleton.module.scss';

const SKELETON_CARD_COUNT = 5;

// 정렬·필터를 바꿔 새 목록을 받는 동안 ShopCard 자리를 채운다. 화면 낭독기에는 목록 영역의 aria-busy로만 알린다
export default function ShopListSkeleton() {
  return Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
    <div key={index} className={styles.card} aria-hidden>
      <div className={styles.card__thumbnail} />
      <div className={styles.card__info}>
        <div className={styles.card__name} />
        <div className={styles.card__rating} />
      </div>
    </div>
  ));
}
