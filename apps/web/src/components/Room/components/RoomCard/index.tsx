import { Link } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';
import ROUTES from 'static/routes';

import RoomCardContent from './RoomCardContent';
import styles from './RoomCard.module.scss';

interface RoomCardProps {
  room: LandList;
  onClick: () => void;
}

export default function RoomCard({ room, onClick }: RoomCardProps) {
  return (
    <Link className={styles.card} to={ROUTES.RoomDetail({ id: String(room.id) })} onClick={onClick}>
      <RoomCardContent room={room} showArrow />
      <span className={styles['card__arrow--pc']} aria-hidden>
        <ChevronRightIcon />
      </span>
    </Link>
  );
}
