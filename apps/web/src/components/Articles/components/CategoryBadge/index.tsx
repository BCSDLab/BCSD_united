import { cn } from '@bcsdlab/utils';

import useLostItemLabels from 'components/Articles/hooks/useLostItemLabels';
import { CATEGORY_BADGE_MODIFIER } from 'static/lostItem';

import styles from './CategoryBadge.module.scss';

interface CategoryBadgeProps {
  category: string;
  isMobile: boolean;
  className?: string;
}

export default function CategoryBadge({ category, isMobile, className }: CategoryBadgeProps) {
  const labels = useLostItemLabels();
  // 분류는 서버가 한국어로 주고 색상 구분도 한국어 값으로 하므로, 번역은 보여줄 때만 한다
  const modifier = CATEGORY_BADGE_MODIFIER[category];
  const showColor = isMobile && !!modifier;

  return (
    <span
      className={cn({
        [className ?? '']: !!className,
        [styles.badge]: showColor,
        [styles[`badge--${modifier}`]]: showColor,
      })}
    >
      {labels.category(category)}
    </span>
  );
}
