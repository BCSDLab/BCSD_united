import { useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';

import type { LandList } from 'api/room/entity';
import RoomCard from 'components/Room/components/RoomCard';
import Button from 'components/ui/Button';
import SearchEmptyState from 'components/ui/SearchEmptyState';
import useLogger from 'utils/hooks/analytics/useLogger';

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
  clusterIds: ReadonlySet<number> | null;
  rentType: RoomRentType;
  onRentTypeChange: (rentType: RoomRentType) => void;
  mapControlsRef: RefObject<HTMLDivElement | null>;
  onSelectRoom: (room: LandList) => void;
  returnFocusRoomId?: number | null;
}

function RoomList(props: RoomListProps) {
  const { lands, clusterIds, rentType, onRentTypeChange, onSelectRoom, mapControlsRef, returnFocusRoomId } = props;
  const logger = useLogger();
  const listId = useId();
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { panelRef, isMobile, isExpanded, handleToggle, dragHandlers } = useRoomPanelDrag(mapControlsRef);
  const listTitle = `${clusterIds ? '묶음' : RENT_TYPE_LABELS[rentType]}(${lands?.length ?? 0})`;

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [clusterIds, rentType]);

  useEffect(() => {
    if (clusterIds) headingRef.current?.focus({ preventScroll: true });
  }, [clusterIds]);

  useEffect(() => {
    returnFocusRef.current?.focus();
  }, [returnFocusRoomId]);

  return (
    <section ref={panelRef} className={styles.panel} aria-label={clusterIds ? '묶음 목록' : '건물 목록'}>
      <div className={styles.header}>
        <h2 ref={headingRef} className={styles.header__count} aria-live="polite" tabIndex={-1}>
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
        <ul ref={listRef} id={listId} className={styles.list}>
          {lands?.map((room) => (
            <li className={styles.list__item} key={room.id}>
              <RoomCard
                room={room}
                onClick={() => {
                  logger.actionEventClick({
                    event_name: 'DA1',
                    event_label: 'real_estate__room_list__room_detail__entry__click',
                    value: room.name,
                  });
                  onSelectRoom(room);
                }}
                buttonRef={room.id === returnFocusRoomId ? returnFocusRef : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default RoomList;
