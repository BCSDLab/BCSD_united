import { useEffect, useRef } from 'react';

import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';

function useNaverMap(
  latitude: number | null,
  longitude: number | null,
  isLoaded: boolean = true,
  { zoomControl = true }: { zoomControl?: boolean } = {},
) {
  const mapRef = useRef<naver.maps.Map | null>(null);

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
    mapRef.current = mapInstance;

    return () => {
      try {
        mapInstance.destroy();
      } catch {
        // Naver Maps SDK 내부 _clearSwipe 타이밍 이슈 방어
      }
      mapRef.current = null;
    };
  }, [isLoaded, latitude, longitude, zoomControl]);

  useEffect(() => {
    const coordinates = { latitude, longitude };
    if (!mapRef.current || !hasValidCoordinates(coordinates)) return;

    mapRef.current.setCenter(new window.naver.maps.LatLng(coordinates.latitude, coordinates.longitude));
  }, [latitude, longitude]);

  const getMap = () => mapRef.current;

  return { getMap };
}

export default useNaverMap;
