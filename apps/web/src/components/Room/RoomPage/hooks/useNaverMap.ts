import { useCallback, useEffect, useState } from 'react';

import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';

function useNaverMap(
  latitude: number | null,
  longitude: number | null,
  isLoaded: boolean = true,
  { zoomControl = true }: { zoomControl?: boolean } = {},
) {
  const [map, setMap] = useState<naver.maps.Map | null>(null);

  useEffect(() => {
    if (!isLoaded || !window.naver?.maps) return;
    const coordinates = { latitude, longitude };
    if (!hasValidCoordinates(coordinates)) return;
    if (!document.getElementById('map')) return;

    const mapInstance = new window.naver.maps.Map('map', {
      center: new window.naver.maps.LatLng(coordinates.latitude, coordinates.longitude),
      maxZoom: 20,
      minZoom: 15,
      logoControl: false,
      zoomControl,
      scrollWheel: false,
      draggable: true,
      zoomControlOptions: { position: window.naver.maps.Position.TOP_LEFT },
    });
    const initListener = window.naver.maps.Event.once(mapInstance, 'init', () => {
      setMap(mapInstance);
    });

    return () => {
      window.naver.maps.Event.removeListener(initListener);
      try {
        mapInstance.destroy();
      } catch {
        // Naver Maps SDK 내부 _clearSwipe 타이밍 이슈 방어
      }
      setMap(null);
    };
  }, [isLoaded, latitude, longitude, zoomControl]);

  useEffect(() => {
    const coordinates = { latitude, longitude };
    if (!map || !hasValidCoordinates(coordinates)) return;

    map.setCenter(new window.naver.maps.LatLng(coordinates.latitude, coordinates.longitude));
  }, [map, latitude, longitude]);

  const getMap = useCallback(() => map, [map]);

  return { getMap };
}

export default useNaverMap;
