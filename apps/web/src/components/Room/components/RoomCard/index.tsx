import { Link } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';
import ROUTES from 'static/routes';

import styles from './RoomCard.module.scss';

interface RoomCardProps {
  room: LandList;
  onClick: () => void;
}

export default function RoomCard({ room, onClick }: RoomCardProps) {
  return (
    <Link className={styles.card} to={ROUTES.RoomDetail({ id: String(room.id) })} onClick={onClick}>
      <div className={styles.card__content}>
        <div className={styles.card__details}>
          <div className={styles.card__heading}>
            <span className={styles.card__name}>{room.name}</span>
            {room.room_type && <span className={styles.card__type}>{room.room_type}</span>}
          </div>
          <div className={styles['card__address-row']}>
            {room.address && <span className={styles.card__address}>{room.address}</span>}
            <span className={styles['card__arrow--mobile']} aria-hidden>
              <ChevronRightIcon />
            </span>
          </div>
        </div>
        {(room.is_monthly_available || room.is_charter_available) && (
          <div className={styles.card__fees}>
            {room.is_monthly_available && (
              <div className={styles.card__fee}>
                <span className={`${styles.card__badge} ${styles['card__badge--monthly']}`}>월세</span>
                <span className={styles.card__inquiry}>별도 문의</span>
              </div>
            )}
            {room.is_charter_available && (
              <div className={styles.card__fee}>
                <span className={`${styles.card__badge} ${styles['card__badge--charter']}`}>전세</span>
                <span className={styles.card__inquiry}>별도 문의</span>
              </div>
            )}
          </div>
        )}
      </div>
      <span className={styles['card__arrow--pc']} aria-hidden>
        <ChevronRightIcon />
      </span>
    </Link>
  );
}
