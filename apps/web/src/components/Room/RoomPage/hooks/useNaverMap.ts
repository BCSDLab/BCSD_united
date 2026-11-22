import { useCallback, useEffect, useRef, useState } from 'react';

import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';

function useNaverMap(
  latitude: number | null,
  longitude: number | null,
  isLoaded: boolean = true,
  { zoomControl = true }: { zoomControl?: boolean } = {},
) {
  const [map, setMap] = useState<naver.maps.Map | null>(null);
  const mapRef = useRef<naver.maps.Map | null>(null);
  const coordinatesRef = useRef({ latitude, longitude });
  const hasCoordinates = hasValidCoordinates({ latitude, longitude });

  useEffect(() => {
    coordinatesRef.current = { latitude, longitude };
  }, [latitude, longitude]);

  useEffect(() => {
    if (!isLoaded || !hasCoordinates || !window.naver?.maps) return;
    // 좌표 값이 바뀌어도 지도는 유지하고, 새 지도를 만들 때만 최신 좌표를 읽는다.
    const coordinates = coordinatesRef.current;
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
    mapRef.current = mapInstance;
    const initListener = window.naver.maps.Event.once(mapInstance, 'init', () => {
      if (mapRef.current === mapInstance) setMap(mapInstance);
    });

    return () => {
      mapRef.current = null;
      window.naver.maps.Event.removeListener(initListener);
      try {
        mapInstance.destroy();
      } catch {
        // Naver Maps SDK 내부 _clearSwipe 타이밍 이슈 방어
      }
      setMap(null);
    };
  }, [isLoaded, hasCoordinates, zoomControl]);

  useEffect(() => {
    const mapInstance = mapRef.current;
    const coordinates = { latitude, longitude };
    if (!mapInstance || !hasValidCoordinates(coordinates)) return;

    mapInstance.setCenter(new window.naver.maps.LatLng(coordinates.latitude, coordinates.longitude));
  }, [latitude, longitude]);

  const getMap = useCallback(() => map, [map]);

  return { getMap };
}

export default useNaverMap;
