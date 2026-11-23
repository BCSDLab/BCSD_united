import type { LandList } from 'api/room/entity';
import ChevronRightIcon from 'assets/svg/Team/chevron-right-icon.svg';

import styles from './RoomCard.module.scss';

export function RoomRentBadge({ type }: { type: 'monthly' | 'charter' }) {
  return (
    <span className={`${styles.card__badge} ${styles[`card__badge--${type}`]}`}>
      {type === 'monthly' ? '월세' : '전세'}
    </span>
  );
}

interface RoomCardContentProps {
  room: LandList;
  showArrow?: boolean;
  className?: string;
}

export default function RoomCardContent({ room, showArrow = false, className }: RoomCardContentProps) {
  return (
    <div className={`${styles.card__content} ${className ?? ''}`}>
      <div className={styles.card__details}>
        <div className={styles.card__heading}>
          <span className={styles.card__name}>{room.name}</span>
          {room.room_type && <span className={styles.card__type}>{room.room_type}</span>}
        </div>
        <div className={styles['card__address-row']}>
          {room.address && <span className={styles.card__address}>{room.address}</span>}
          {showArrow && (
            <span className={styles['card__arrow--mobile']} aria-hidden>
              <ChevronRightIcon />
            </span>
          )}
        </div>
      </div>
      {(room.is_monthly_available || room.is_charter_available) && (
        <div className={styles.card__fees}>
          {room.is_monthly_available && (
            <div className={styles.card__fee}>
              <RoomRentBadge type="monthly" />
              <span className={styles.card__inquiry}>별도 문의</span>
            </div>
          )}
          {room.is_charter_available && (
            <div className={styles.card__fee}>
              <RoomRentBadge type="charter" />
              <span className={styles.card__inquiry}>별도 문의</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
