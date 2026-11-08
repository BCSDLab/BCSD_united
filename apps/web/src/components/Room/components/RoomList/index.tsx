import { Link } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import ROUTES from 'static/routes';
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
          <Link
            className={styles.list__link}
            to={ROUTES.RoomDetail({ id: String(room.id) })}
            onClick={() =>
              // 복덕방 2-1 목록의 방 카드
              logger.actionEventClick({
                event_name: 'DA1',
                event_label: 'real_estate__room_list__room_detail__entry__click',
                value: room.name,
              })
            }
          >
            <div className={styles.list__box}>
              <div className={styles.list__name}>{room.name}</div>
              <div className={styles.fee}>
                <div className={styles.fee__info}>
                  <span className={styles.fee__monthly}>월세</span>
                  <span>{room.monthly_fee ? room.monthly_fee : '정보없음'}</span>
                </div>
                <div className={styles.fee__info}>
                  <span className={styles.fee__charter}>전세</span>
                  <span>{room.charter_fee ? `${room.charter_fee}만원` : ' - '}</span>
                </div>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default RoomList;
