import type { LandList } from 'api/room/entity';
import RoomCard from 'components/Room/components/RoomCard';
import useLogger from 'utils/hooks/analytics/useLogger';

import styles from './RoomList.module.scss';

interface RoomListProps {
  lands: LandList[] | undefined;
}

function RoomList(props: RoomListProps) {
  const { lands } = props;
  const logger = useLogger();

  return (
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
  );
}

export default RoomList;
