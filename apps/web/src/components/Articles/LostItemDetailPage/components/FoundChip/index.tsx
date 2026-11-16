import { cn } from '@bcsdlab/utils';

import useLostItemLabels from 'components/Articles/hooks/useLostItemLabels';

import styles from './FoundChip.module.scss';

type ChipSize = 'xs' | 'large';

interface FoundChipProps {
  isFound: boolean;
  size?: ChipSize;
}

export default function FoundChip({ isFound, size = 'large' }: FoundChipProps) {
  const labels = useLostItemLabels();

  return (
    <div
      className={cn({
        [styles.chip]: true,
        [styles[`chip--${size}`]]: true,
        [styles['chip--found']]: isFound,
      })}
    >
      {labels.foundStatus(isFound)}
    </div>
  );
}
