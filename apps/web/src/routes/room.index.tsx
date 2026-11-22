import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { LandList } from 'api/room/entity';
import { roomQueries } from 'api/room/queries';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import RoomList, { type RoomRentType } from 'components/Room/components/RoomList';
import RoomMapControls from 'components/Room/components/RoomMapControls';
import RoomSelection from 'components/Room/components/RoomSelection';
import useMarker from 'components/Room/RoomPage/hooks/useMarker';
import useNaverMap from 'components/Room/RoomPage/hooks/useNaverMap';
import useNaverMapScript from 'components/Room/RoomPage/hooks/useNaverMapScript';
import hasValidCoordinates from 'components/Room/utils/hasValidCoordinates';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/RoomPage.module.scss';

const LOCATION = { latitude: 36.764617, longitude: 127.283154 };

function RoomPage() {
  const { data: roomList } = useQuery(roomQueries.list());
  const [rentType, setRentType] = useState<RoomRentType>('all');
  const [selectedRoom, setSelectedRoom] = useState<LandList | null>(null);
  const [returnFocusRoomId, setReturnFocusRoomId] = useState<number | null>(null);
  const mapControlsRef = useRef<HTMLDivElement>(null);
  const handleSelectRoom = (room: LandList) => {
    setReturnFocusRoomId(room.id);
    setSelectedRoom(room);
  };
  const handleSelectMarker = useCallback((room: LandList) => {
    setReturnFocusRoomId(null);
    setSelectedRoom(room);
  }, []);
  const lands = useMemo(
    () =>
      roomList?.lands?.filter((room) => {
        if (rentType === 'monthly') return room.is_monthly_available;
        if (rentType === 'charter') return room.is_charter_available;

        return true;
      }),
    [roomList, rentType],
  );
  const isMapLoaded = useNaverMapScript();
  const { getMap } = useNaverMap(LOCATION.latitude, LOCATION.longitude, isMapLoaded, {
    zoomControl: false,
  });
  useEffect(() => {
    const map = getMap();
    if (!map || !selectedRoom || !hasValidCoordinates(selectedRoom)) return;
    map.setCenter(new window.naver.maps.LatLng(selectedRoom.latitude, selectedRoom.longitude));
  }, [getMap, selectedRoom]);
  useMarker({ getMap, lands, onSelect: handleSelectMarker, selectedRoomId: selectedRoom?.id });

  useScrollToTop();

  return (
    <div className={styles.template}>
      <MobilePageHeader title="복덕방" className={styles['mobile-header']} />
      <h1 className={styles.title}>복덕방</h1>
      <div className={styles.content}>
        <div id="map" className={styles.map} />
        {selectedRoom ? (
          <RoomSelection
            key={selectedRoom.id}
            room={selectedRoom}
            onClose={() => setSelectedRoom(null)}
            mapControlsRef={mapControlsRef}
          />
        ) : (
          <RoomList
            lands={lands}
            rentType={rentType}
            onRentTypeChange={setRentType}
            onSelectRoom={handleSelectRoom}
            returnFocusRoomId={returnFocusRoomId}
            mapControlsRef={mapControlsRef}
          />
        )}
        <div ref={mapControlsRef} className={styles['map-controls']}>
          <RoomMapControls onZoom={(delta) => getMap()?.zoomBy(delta)} />
        </div>
      </div>
    </div>
  );
}

const loadPage = definePageLoad(async ({ queryClient }, cacheControl) => {
  await withStaticFetchRetry('room.list', () => queryClient.fetchQuery(roomQueries.list()));

  cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/room/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <RoomPage />;

  return (
    <SSRLayout className={styles.layout} mobileHeader="page" fitViewport>
      {page}
    </SSRLayout>
  );
}
