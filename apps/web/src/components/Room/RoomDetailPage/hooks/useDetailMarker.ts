import { useEffect, useRef } from 'react';

import MarkerIcon from 'components/Room/components/MarkerIcon';
import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';

interface DetailMarkerProps {
  getMap: () => naver.maps.Map | null;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}

export default function useDetailMarker({ getMap, latitude, longitude }: DetailMarkerProps) {
  const markerRef = useRef<naver.maps.Marker | null>(null);

  useEffect(() => {
    const map = getMap();
    const coordinates = { latitude, longitude };
    if (!map || !hasValidCoordinates(coordinates) || !window.naver) return;

    const clearMarker = () => {
      if (markerRef.current) {
        markerRef.current.setMap(null);
        markerRef.current = null;
      }
    };
    clearMarker();

    const marker = new naver.maps.Marker({
      position: new naver.maps.LatLng(coordinates.latitude, coordinates.longitude),
      map,
      icon: { content: MarkerIcon() },
    });
    markerRef.current = marker;

    return clearMarker;
  }, [getMap, latitude, longitude]);

  const getMarker = () => markerRef.current;

  return { getMarker };
}
