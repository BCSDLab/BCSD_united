import useDetailMarker from 'components/Room/RoomDetailPage/hooks/useDetailMarker';
import useNaverMap from 'components/Room/RoomPage/hooks/useNaverMap';
import useNaverMapScript from 'components/Room/RoomPage/hooks/useNaverMapScript';

import styles from './RoomDetailMap.module.scss';

interface RoomDetailMapProps {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

function RoomDetailMap({ latitude, longitude, address }: RoomDetailMapProps) {
  const isMapLoaded = useNaverMapScript();
  const { getMap } = useNaverMap(latitude, longitude, isMapLoaded);
  useDetailMarker({ getMap, latitude, longitude });

  const hasCoordinates = latitude != null && longitude != null && latitude !== 0 && longitude !== 0;

  return (
    <div className={styles['map-container']}>
      <div className={styles['map-container__address']}>{address}</div>
      {hasCoordinates && <div id="map" className={styles['map-container__map']} />}
    </div>
  );
}

export default RoomDetailMap;
