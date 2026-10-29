import EmptyStar from 'assets/svg/Review/empty-star.svg';
import Star from 'assets/svg/Review/star.svg';

interface Props {
  average_rating: number;
}

export default function StarList({ average_rating }: Props) {
  const emptyStarList = Array.from({ length: 5 - Math.floor(average_rating) }, () => false);
  const starList = Array.from({ length: Math.floor(average_rating) }, () => true);

  const rating = [...starList, ...emptyStarList];

  return (
    <div>
      {/* eslint-disable-next-line react/no-array-index-key -- 별점은 항상 고정 5칸이며 위치 자체가 의미를 가진다. */}
      {rating.map((ratio, idx) => (ratio ? <Star key={idx} /> : <EmptyStar key={idx} />))}
    </div>
  );
}
