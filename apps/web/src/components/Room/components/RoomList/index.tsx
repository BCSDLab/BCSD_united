import { useId } from 'react';
import type { RefObject } from 'react';

import type { LandList } from 'api/room/entity';
import RoomCard from 'components/Room/components/RoomCard';
import Button from 'components/ui/Button';
import SearchEmptyState from 'components/ui/SearchEmptyState';

import useRoomPanelDrag from './hooks/useRoomPanelDrag';
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
  mapControlsRef: RefObject<HTMLDivElement | null>;
  onSelectRoom: (room: LandList) => void;
}

function RoomList(props: RoomListProps) {
  const { lands, rentType, onRentTypeChange, onSelectRoom, mapControlsRef } = props;
  const listId = useId();
  const { panelRef, isMobile, isExpanded, handleToggle, dragHandlers } = useRoomPanelDrag(mapControlsRef);
  const listTitle = `${RENT_TYPE_LABELS[rentType]}(${lands?.length ?? 0})`;

  return (
    <section ref={panelRef} className={styles.panel} aria-label="건물 목록">
      <div className={styles.header}>
        <h2 className={styles.header__count} aria-live="polite">
          {isMobile ? (
            <button
              type="button"
              className={styles['header__drag-handle']}
              aria-label={`${listTitle} 목록 ${isExpanded ? '접기' : '펼치기'}`}
              aria-expanded={isExpanded}
              aria-controls={listId}
              onClick={handleToggle}
              {...dragHandlers}
            >
              {listTitle}
            </button>
          ) : (
            listTitle
          )}
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
      {lands?.length === 0 ? (
        <SearchEmptyState id={listId} className={styles.empty} />
      ) : (
        <ul id={listId} className={styles.list}>
          {lands?.map((room) => (
            <li className={styles.list__item} key={room.id}>
              <RoomCard room={room} onClick={() => onSelectRoom(room)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default RoomList;
