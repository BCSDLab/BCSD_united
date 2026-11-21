import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Link } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import CloseIcon from 'assets/svg/close-icon.svg';
import RoomCardContent from 'components/Room/components/RoomCard/RoomCardContent';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import RoomSelectionDetail from './RoomSelectionDetail';
import styles from './RoomSelection.module.scss';

interface RoomSelectionProps {
  room: LandList;
  onClose: () => void;
  mapControlsRef: RefObject<HTMLDivElement | null>;
}

export default function RoomSelection({ room, onClose, mapControlsRef }: RoomSelectionProps) {
  const isMobile = useMediaQuery();
  const logger = useLogger();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    const controls = mapControlsRef.current;
    if (!isMobile || !panel || !controls) return;

    const updateControls = () => {
      controls.style.bottom = `${panel.getBoundingClientRect().height + 12}px`;
    };
    updateControls();
    const observer = new ResizeObserver(updateControls);
    observer.observe(panel);

    return () => {
      observer.disconnect();
      controls.style.removeProperty('bottom');
    };
  }, [isMobile, mapControlsRef]);

  return (
    <section ref={panelRef} className={styles.panel} aria-label={`${room.name} 선택 정보`}>
      <button
        ref={closeRef}
        type="button"
        className={styles.close}
        aria-label="건물 목록으로 돌아가기"
        onClick={onClose}
      >
        <CloseIcon aria-hidden />
      </button>
      {isMobile ? (
        <>
          <RoomCardContent room={room} className={styles.summary} />
          <Link
            to={ROUTES.RoomDetail({ id: String(room.id) })}
            className={styles.detail}
            onClick={() =>
              logger.actionEventClick({
                event_name: 'DA1',
                event_label: 'real_estate__room_list__room_detail__entry__click',
                value: room.name,
              })
            }
          >
            매물 상세보기
          </Link>
        </>
      ) : (
        <RoomSelectionDetail room={room} />
      )}
    </section>
  );
}
