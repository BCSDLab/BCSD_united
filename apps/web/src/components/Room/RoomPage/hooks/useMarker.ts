import { useEffect, useRef } from 'react';

import type { LandList } from 'api/room/entity';
import MarkerIcon from 'components/Room/components/MarkerIcon';
import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';

import styles from 'components/Room/components/MarkerIcon/MarkerIcon.module.scss';

interface MarkerProps {
  getMap: () => naver.maps.Map | null;
  lands: LandList[] | undefined;
  onSelect: (room: LandList) => void;
  selectedRoomId: number | undefined;
}

function useMarker({ getMap, lands, onSelect, selectedRoomId }: MarkerProps) {
  const markersRef = useRef<Array<{ id: number; marker: naver.maps.Marker }>>([]);

  useEffect(() => {
    const map = getMap();
    if (!map || !lands || !window.naver) return;

    const clearMarkers = () => {
      markersRef.current.forEach(({ marker }) => marker.setMap(null));
      markersRef.current = [];
    };
    clearMarkers();

    const created = lands.flatMap((land) => {
      if (!hasValidCoordinates(land)) return [];

      const marker = new window.naver.maps.Marker({
        position: new window.naver.maps.LatLng(land.latitude, land.longitude),
        title: land.name,
        map,
        icon: { content: MarkerIcon() },
        clickable: true,
      });
      marker.addListener('click', () => {
        onSelect(land);
      });

      return [{ id: land.id, marker }];
    });

    markersRef.current = created;

    return clearMarkers;
  }, [getMap, lands, onSelect]);

  useEffect(() => {
    markersRef.current.forEach(({ id, marker }) => {
      marker.getElement().classList.toggle(styles.selected, id === selectedRoomId);
      marker.setZIndex(id === selectedRoomId ? 1 : 0);
    });
  }, [getMap, lands, onSelect, selectedRoomId]);

  const getMarkerArray = () => markersRef.current.map(({ marker }) => marker);

  return { getMarkerArray };
}

export default useMarker;
