import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Link } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import CloseIcon from 'assets/svg/close-icon.svg';
import RoomCardContent from 'components/Room/components/RoomCard/RoomCardContent';
import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import RoomSelectionDetail from './RoomSelectionDetail';
import styles from './RoomSelection.module.scss';

const MAP_CONTROLS_GAP = 12;

interface RoomSelectionProps {
  room: LandList;
  onClose: () => void;
  getMap: () => naver.maps.Map | null;
  mapControlsRef: RefObject<HTMLDivElement | null>;
}

export default function RoomSelection({ room, onClose, getMap, mapControlsRef }: RoomSelectionProps) {
  const isMobile = useMediaQuery();
  const logger = useLogger();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    const controls = mapControlsRef.current;
    if (!panel || !container) return;

    const updateLayout = () => {
      const panelHeight = panel.getBoundingClientRect().height;
      const containerHeight = container.getBoundingClientRect().height;
      if (isMobile && controls) {
        const controlsHeight = controls.getBoundingClientRect().height;
        controls.style.bottom = `${panelHeight + MAP_CONTROLS_GAP}px`;
        controls.style.visibility =
          panelHeight + controlsHeight + MAP_CONTROLS_GAP * 2 <= containerHeight ? '' : 'hidden';
      }

      const map = getMap();
      if (!map || !hasValidCoordinates(room)) return;
      const position = new window.naver.maps.LatLng(room.latitude, room.longitude);
      if (!isMobile) {
        map.setCenter(position);

        return;
      }

      // 하단 패널에 가려지지 않은 지도 영역의 중앙에 선택한 건물이 오도록 보정한다.
      const projection = map.getProjection();
      const offset = projection.fromCoordToOffset(position);
      const center = projection.fromOffsetToCoord(
        new window.naver.maps.Point(offset.x, offset.y + Math.min(panelHeight, containerHeight) / 2),
      );
      map.setCenter(center);
    };
    updateLayout();
    if (!isMobile) return;

    const observer = new ResizeObserver(updateLayout);
    observer.observe(panel);
    observer.observe(container);

    return () => {
      observer.disconnect();
      controls?.style.removeProperty('bottom');
      controls?.style.removeProperty('visibility');
    };
  }, [isMobile, getMap, mapControlsRef, room]);

  return (
    <section ref={panelRef} className={styles.panel} aria-label={`${room.name} 선택 정보`}>
      <button
        ref={closeRef}
        type="button"
        className={styles.close}
        aria-label="건물 목록으로 돌아가기"
        onClick={() => {
          if (isMobile) {
            logger.actionEventClick({
              event_name: 'DA1',
              event_label: 'real_estate__room_list__room_preview__close__click',
              value: '닫기',
            });
          }
          onClose();
        }}
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
                event_label: 'real_estate__room_list__room_detail__button_entry__click',
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
