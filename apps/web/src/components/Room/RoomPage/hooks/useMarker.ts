import { useEffect, useRef } from 'react';

import type { LandList } from 'api/room/entity';
import MarkerIcon from 'components/Room/components/MarkerIcon';
import clusterRoomMarkers from 'components/Room/utils/clusterRoomMarkers';
import createRoomMarkerAnimator, { type RoomMarkerGroup } from 'components/Room/utils/createRoomMarkerAnimator';
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
  const selectedRoomIdRef = useRef(selectedRoomId);
  const updateClustersRef = useRef<(() => void) | null>(null);

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
        visible: false,
        icon: { content: MarkerIcon() },
        clickable: true,
      });
      clickListeners.push(marker.addListener('click', () => onSelect(land)));

      return [{ id: land.id, marker }];
    });

    markersRef.current = created;
    const markersById = new Map(created.map(({ id, marker }) => [id, marker]));
    const animator = createRoomMarkerAnimator(map);
    let previousZoom = map.getZoom();
    let previousSelectedId = selectedRoomIdRef.current;
    let activeClusterKeys = new Set<string>();
    const updateClusters = () => {
      const selectedId = selectedRoomIdRef.current;
      const projection = map.getProjection();
      const points =
        selectedId === undefined
          ? created.map(({ id, marker }) => {
              const point = projection.fromCoordToOffset(marker.getPosition());

              return { id, x: point.x, y: point.y };
            })
          : [];
      const groups = clusterRoomMarkers(points);
      const displayGroups: RoomMarkerGroup[] = [];
      activeClusterKeys = new Set<string>();
      if (selectedId !== undefined) {
        const selectedMarker = markersById.get(selectedId);
        if (selectedMarker) displayGroups.push({ ids: [selectedId], marker: selectedMarker });
      }

      groups.forEach((group) => {
        if (group.length === 1) {
          const marker = markersById.get(group[0].id);
          if (marker) displayGroups.push({ ids: [group[0].id], marker });

          return;
        }

        const ids = group.map(({ id }) => id);
        const key = ids.join(',');
        activeClusterKeys.add(key);
        let marker = clustersRef.current.get(key);
        if (!marker) {
          const centerMarker = markersById.get(group[0].id);
          if (!centerMarker) return;

          marker = new window.naver.maps.Marker({
            position: centerMarker.getPosition(),
            map,
            visible: false,
            icon: { content: MarkerIcon(group.length) },
            title: `건물 ${group.length}개`,
            clickable: false,
          });
          clustersRef.current.set(key, marker);
        }
        const clusterMarker = marker;
        displayGroups.push({
          ids,
          marker: clusterMarker,
          onHide: () => {
            if (selectedRoomIdRef.current !== undefined || activeClusterKeys.has(key)) return;
            clusterMarker.setMap(null);
            clustersRef.current.delete(key);
          },
        });
      });

      const zoom = map.getZoom();
      animator.update(
        displayGroups,
        zoom !== previousZoom && selectedId === undefined && previousSelectedId === undefined,
      );
      previousZoom = zoom;
      previousSelectedId = selectedId;
      clustersRef.current.forEach((marker, key) => {
        if (selectedId === undefined && !activeClusterKeys.has(key) && !marker.getVisible()) {
          marker.setMap(null);
          clustersRef.current.delete(key);
        }
      });
    };
    updateClustersRef.current = updateClusters;
    const idleListener = window.naver.maps.Event.addListener(map, 'idle', updateClusters);

    return () => {
      window.naver.maps.Event.removeListener([idleListener, ...clickListeners]);
      updateClustersRef.current = null;
      animator.clear();
      clearMarkers();
    };
  }, [getMap, lands, onSelect]);

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoomId;
    updateClustersRef.current?.();
    markersRef.current.forEach(({ id, marker }) => {
      marker.getElement().classList.toggle(styles.selected, id === selectedRoomId);
      marker.setZIndex(id === selectedRoomId ? 1 : 0);
    });
  }, [getMap, lands, onSelect, selectedRoomId]);

  const getMarkerArray = () => markersRef.current.map(({ marker }) => marker);

  return { getMarkerArray };
}

export default useMarker;
