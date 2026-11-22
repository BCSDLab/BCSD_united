import { useEffect, useRef } from 'react';

import type { LandList } from 'api/room/entity';
import MarkerIcon from 'components/Room/components/MarkerIcon';
import clusterRoomMarkers from 'components/Room/utils/clusterRoomMarkers';
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
  const clustersRef = useRef(new Map<string, naver.maps.Marker>());

  useEffect(() => {
    const map = getMap();
    if (!map || !lands || !window.naver?.maps) return;

    const clearMarkers = () => {
      markersRef.current.forEach(({ marker }) => marker.setMap(null));
      markersRef.current = [];
      clustersRef.current.forEach((marker) => marker.setMap(null));
      clustersRef.current.clear();
    };
    clearMarkers();

    const clickListeners: naver.maps.MapEventListener[] = [];
    const created = lands.flatMap((land) => {
      if (!hasValidCoordinates(land)) return [];

      const marker = new window.naver.maps.Marker({
        position: new window.naver.maps.LatLng(land.latitude, land.longitude),
        title: land.name,
        map,
        icon: { content: MarkerIcon() },
        clickable: true,
      });
      clickListeners.push(marker.addListener('click', () => onSelect(land)));

      return [{ id: land.id, marker }];
    });

    markersRef.current = created;
    const markersById = new Map(created.map(({ id, marker }) => [id, marker]));
    const updateClusters = () => {
      const projection = map.getProjection();
      const points = created.map(({ id, marker }) => {
        const point = projection.fromCoordToOffset(marker.getPosition());

        return { id, x: point.x, y: point.y };
      });
      const groups = clusterRoomMarkers(points);
      const visibleMarkerIds = new Set<number>();
      const activeClusterKeys = new Set<string>();

      groups.forEach((group) => {
        if (group.length === 1) {
          visibleMarkerIds.add(group[0].id);

          return;
        }

        const key = group.map(({ id }) => id).join(',');
        activeClusterKeys.add(key);
        if (clustersRef.current.has(key)) return;
        const centerMarker = markersById.get(group[0].id);
        if (!centerMarker) return;

        clustersRef.current.set(
          key,
          new window.naver.maps.Marker({
            position: centerMarker.getPosition(),
            map,
            icon: { content: MarkerIcon(group.length) },
            title: `건물 ${group.length}개`,
            clickable: false,
          }),
        );
      });

      created.forEach(({ id, marker }) => {
        const visible = visibleMarkerIds.has(id);
        if (marker.getVisible() !== visible) marker.setVisible(visible);
      });
      clustersRef.current.forEach((marker, key) => {
        if (!activeClusterKeys.has(key)) {
          marker.setMap(null);
          clustersRef.current.delete(key);
        }
      });
    };
    updateClusters();
    const idleListener = window.naver.maps.Event.addListener(map, 'idle', updateClusters);

    return () => {
      window.naver.maps.Event.removeListener([idleListener, ...clickListeners]);
      clearMarkers();
    };
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
