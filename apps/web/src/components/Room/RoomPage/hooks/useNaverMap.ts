import { useEffect, useRef } from 'react';

function useNaverMap(
  latitude: number | null,
  longitude: number | null,
  isLoaded: boolean = true,
  { zoomControl = true }: { zoomControl?: boolean } = {},
) {
  const mapRef = useRef<naver.maps.Map | null>(null);

  useEffect(() => {
    if (!isLoaded || !window.naver?.maps) return;
    if (latitude == null || longitude == null || latitude === 0 || longitude === 0) return;
    if (!document.getElementById('map')) return;

    const mapInstance = new window.naver.maps.Map('map', {
      center: new window.naver.maps.LatLng(latitude, longitude),
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
    if (!mapRef.current || latitude == null || longitude == null || latitude === 0 || longitude === 0) return;

    mapRef.current.setCenter(new window.naver.maps.LatLng(latitude, longitude));
  }, [latitude, longitude]);

  const getMap = () => mapRef.current;

  return { getMap };
}

export default useNaverMap;
