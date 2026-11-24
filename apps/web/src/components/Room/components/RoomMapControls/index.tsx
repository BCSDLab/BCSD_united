import { cn } from '@bcsdlab/utils';

import MinusIcon from 'assets/svg/Room/map-minus.svg';
import PlusIcon from 'assets/svg/timetable-list-plus-icon.svg';

import styles from './RoomMapControls.module.scss';

interface RoomMapControlsProps {
  className?: string;
  onZoom: (delta: number) => void;
}

export default function RoomMapControls({ className, onZoom }: RoomMapControlsProps) {
  return (
    <div
      className={cn({ [styles.controls]: true, [className ?? '']: !!className })}
      role="group"
      aria-label="지도 확대·축소"
    >
      <button type="button" className={styles.controls__button} aria-label="지도 확대" onClick={() => onZoom(1)}>
        <PlusIcon className={styles.controls__plus} width={24} height={24} aria-hidden />
      </button>
      <button type="button" className={styles.controls__button} aria-label="지도 축소" onClick={() => onZoom(-1)}>
        <MinusIcon aria-hidden />
      </button>
    </div>
  );
}
