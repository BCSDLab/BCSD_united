import { cn } from '@bcsdlab/utils';

import SleepIcon from 'assets/svg/common/sleep-bbico.svg';

import styles from './SearchEmptyState.module.scss';

interface SearchEmptyStateProps {
  id?: string;
  className?: string;
}

export default function SearchEmptyState({ id, className }: SearchEmptyStateProps) {
  return (
    <div id={id} className={cn({ [styles.empty]: true, [className ?? '']: !!className })}>
      <SleepIcon className={styles.empty__icon} aria-hidden />
      <p className={styles.empty__text}>
        검색결과가 없습니다.
        <br />
        다른 검색어로 다시 검색해주세요.
      </p>
    </div>
  );
}
