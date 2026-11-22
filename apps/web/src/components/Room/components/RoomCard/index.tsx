import type { RefObject } from 'react';

import type { LandList } from 'api/room/entity';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';

import RoomCardContent from './RoomCardContent';
import styles from './RoomCard.module.scss';

interface RoomCardProps {
  room: LandList;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export default function RoomCard({ room, onClick, buttonRef }: RoomCardProps) {
  return (
    <button ref={buttonRef} type="button" className={styles.card} onClick={onClick}>
      <RoomCardContent room={room} showArrow />
      <span className={styles['card__arrow--pc']} aria-hidden>
        <ChevronRightIcon />
      </span>
    </button>
  );
}
