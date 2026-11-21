import type { LandList } from 'api/room/entity';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';

import RoomCardContent from './RoomCardContent';
import styles from './RoomCard.module.scss';

interface RoomCardProps {
  room: LandList;
  onClick: () => void;
}

export default function RoomCard({ room, onClick }: RoomCardProps) {
  return (
    <button type="button" className={styles.card} onClick={onClick}>
      <RoomCardContent room={room} showArrow />
      <span className={styles['card__arrow--pc']} aria-hidden>
        <ChevronRightIcon />
      </span>
    </button>
  );
}
