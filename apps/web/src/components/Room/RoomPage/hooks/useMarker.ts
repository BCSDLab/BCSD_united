import { useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';

import type { LandList } from 'api/room/entity';
import MarkerIcon from 'components/Room/components/MarkerIcon';
import ROUTES from 'static/routes';

interface MarkerProps {
  getMap: () => naver.maps.Map | null;
  lands: LandList[] | undefined;
}

function useMarker({ getMap, lands }: MarkerProps) {
  const markersRef = useRef<naver.maps.Marker[]>([]);
  const router = useRouter();

  useEffect(() => {
    const map = getMap();
    if (!map || !lands || !window.naver) return;

    const clearMarkers = () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    };
    clearMarkers();

    const created = lands.flatMap((land) => {
      if (land.latitude == null || land.longitude == null || land.latitude === 0 || land.longitude === 0) return [];

      const marker = new window.naver.maps.Marker({
        position: new window.naver.maps.LatLng(land.latitude, land.longitude),
        title: land.name,
        map,
        icon: { content: MarkerIcon() },
        clickable: true,
      });
      marker.addListener('click', () => {
        router.navigate({ href: ROUTES.RoomDetail({ id: String(land.id) }) });
      });

      return [marker];
    });

    markersRef.current = created;

    return clearMarkers;
  }, [getMap, lands, router]);

  const getMarkerArray = () => markersRef.current;

  return { getMarkerArray };
}

export default useMarker;
