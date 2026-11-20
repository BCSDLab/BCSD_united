import type { LandList } from 'api/room/entity';
import RoomCard from 'components/Room/components/RoomCard';
import Button from 'components/ui/Button';
import useLogger from 'utils/hooks/analytics/useLogger';

import styles from './RoomList.module.scss';

export type RoomRentType = 'all' | 'monthly' | 'charter';

const RENT_TYPES: RoomRentType[] = ['all', 'monthly', 'charter'];
const RENT_TYPE_LABELS: Record<RoomRentType, string> = {
  all: '전체',
  monthly: '월세',
  charter: '전세',
};

interface RoomListProps {
  lands: LandList[] | undefined;
  rentType: RoomRentType;
  onRentTypeChange: (rentType: RoomRentType) => void;
}

function RoomList(props: RoomListProps) {
  const { lands, rentType, onRentTypeChange } = props;
  const logger = useLogger();

  return (
    <section className={styles.panel} aria-label="건물 목록">
      <div className={styles.header}>
        <h2 className={styles.header__count} aria-live="polite">
          {RENT_TYPE_LABELS[rentType]}({lands?.length ?? 0})
        </h2>
        <div className={styles.filters} role="group" aria-label="매물 종류">
          {RENT_TYPES.map((type) => (
            <Button
              key={type}
              color={rentType === type ? 'primary' : 'neutral'}
              size="sm"
              className={styles.filters__button}
              aria-pressed={rentType === type}
              onClick={() => onRentTypeChange(type)}
            >
              {RENT_TYPE_LABELS[type]}
            </Button>
          ))}
        </div>
      </div>
      <ul className={styles.list}>
        {lands?.map((room) => (
          <li className={styles.list__item} key={room.id}>
            <RoomCard
              room={room}
              onClick={() =>
                logger.actionEventClick({
                  event_name: 'DA1',
                  event_label: 'real_estate__room_list__room_detail__entry__click',
                  value: room.name,
                })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export default RoomList;
