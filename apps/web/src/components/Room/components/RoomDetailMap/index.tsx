import RoomMapControls from 'components/Room/components/RoomMapControls';
import useDetailMarker from 'components/Room/RoomDetailPage/hooks/useDetailMarker';
import useNaverMap from 'components/Room/RoomPage/hooks/useNaverMap';
import useNaverMapScript from 'components/Room/RoomPage/hooks/useNaverMapScript';
import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import styles from './RoomDetailMap.module.scss';

interface RoomDetailMapProps {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

function RoomDetailMap({ latitude, longitude, address }: RoomDetailMapProps) {
  const isMobile = useMediaQuery();
  const hasCoordinates = hasValidCoordinates({ latitude, longitude });
  const { isLoaded, hasError: hasScriptError } = useNaverMapScript(hasCoordinates);
  const { getMap, hasError: hasMapError } = useNaverMap(latitude, longitude, isLoaded, {
    zoomControl: !isMobile,
  });
  useDetailMarker({ getMap, latitude, longitude });
  const map = getMap();
  const hasError = hasScriptError || hasMapError;
  const statusMessage = !hasCoordinates ? '좌표 확인 중' : '지도를 불러오지 못했어요';

  return (
    <div className={styles['map-container']}>
      <div className={styles['map-container__address']}>{address?.trim() || '-'}</div>
      {!hasCoordinates || hasError ? (
        <p role="status">{statusMessage}</p>
      ) : (
        <div className={styles['map-container__wrapper']} aria-busy={!map}>
          <div id="map" className={styles['map-container__map']} />
          {isMobile && map && (
            <RoomMapControls className={styles['map-container__controls']} onZoom={(delta) => map.zoomBy(delta)} />
          )}
        </div>
      )}
    </div>
  );
}

export default RoomDetailMap;
