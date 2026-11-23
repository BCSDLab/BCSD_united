import { useRef, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { LandList } from 'api/room/entity';
import { roomQueries } from 'api/room/queries';
import SearchIcon from 'assets/svg/Articles/search.svg';
import DesktopSearchIcon from 'assets/svg/search-01.svg';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import RoomList, { type RoomRentType } from 'components/Room/components/RoomList';
import RoomMapControls from 'components/Room/components/RoomMapControls';
import RoomSearchField from 'components/Room/components/RoomSearchField';
import RoomSelection from 'components/Room/components/RoomSelection';
import useMarker from 'components/Room/RoomPage/hooks/useMarker';
import useNaverMap from 'components/Room/RoomPage/hooks/useNaverMap';
import useNaverMapScript from 'components/Room/RoomPage/hooks/useNaverMapScript';
import useRoomSearch from 'components/Room/RoomPage/hooks/useRoomSearch';
import SearchEmptyState from 'components/ui/SearchEmptyState';
import ROUTES from 'static/routes';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/RoomPage.module.scss';

const LOCATION = { latitude: 36.764617, longitude: 127.283154 };

function RoomPage() {
  const { rooms, results, keyword, searchRooms } = useRoomSearch();
  const isSearchEmpty = !!keyword && results?.length === 0;
  const [rentType, setRentType] = useState<RoomRentType>('all');
  const [selectedRoom, setSelectedRoom] = useState<LandList | null>(null);
  const [clusterRoomIds, setClusterRoomIds] = useState<Set<number> | null>(null);
  const [returnFocusRoomId, setReturnFocusRoomId] = useState<number | null>(null);
  const [previousKeyword, setPreviousKeyword] = useState(keyword);
  const mapControlsRef = useRef<HTMLDivElement>(null);
  const handleSelectRoom = (room: LandList) => {
    setReturnFocusRoomId(room.id);
    setSelectedRoom(room);
  };
  const handleSelectMarker = (room: LandList) => {
    setReturnFocusRoomId(null);
    setSelectedRoom(room);
  };
  const handleSelectCluster = (ids: number[]) => {
    setSelectedRoom(null);
    setReturnFocusRoomId(null);
    setClusterRoomIds(new Set(ids));
  };
  const lands = results?.filter((room) => {
    if (rentType === 'monthly') return room.is_monthly_available;
    if (rentType === 'charter') return room.is_charter_available;

    return true;
  });
  const listLands = clusterRoomIds ? lands?.filter(({ id }) => clusterRoomIds.has(id)) : lands;
  const { isLoaded: isMapLoaded, hasError: hasMapScriptError } = useNaverMapScript();
  const { getMap, hasError: hasMapInitError } = useNaverMap(LOCATION.latitude, LOCATION.longitude, isMapLoaded, {
    zoomControl: false,
  });
  const hasMapError = hasMapScriptError || hasMapInitError;
  useMarker({
    getMap,
    lands,
    onSelect: handleSelectMarker,
    onSelectCluster: handleSelectCluster,
    selectedRoomId: selectedRoom?.id,
  });

  useScrollToTop();

  if (previousKeyword !== keyword) {
    setPreviousKeyword(keyword);
    setSelectedRoom(null);
    setReturnFocusRoomId(null);
    setClusterRoomIds(null);
  }

  return (
    <div className={styles.template}>
      <MobilePageHeader
        title="복덕방"
        className={styles['mobile-header']}
        rightAction={
          <Link to={ROUTES.RoomSearch()} className={styles['search-link']} aria-label="건물 검색">
            <SearchIcon aria-hidden />
          </Link>
        }
      />
      <h1 className={styles.title}>복덕방</h1>
      <RoomSearchField
        key={keyword}
        keyword={keyword}
        rooms={rooms}
        onSearch={(value) => {
          setSelectedRoom(null);
          setReturnFocusRoomId(null);
          setClusterRoomIds(null);

          return searchRooms(value);
        }}
        className={styles['desktop-search']}
        searchIcon={<DesktopSearchIcon className={styles['desktop-search-icon']} aria-hidden />}
      />
      <div className={`${styles.content} ${isSearchEmpty ? styles['content--empty'] : ''}`}>
        {hasMapError ? (
          <p className={styles['map-error']} role="status">
            지도를 불러오지 못했어요
          </p>
        ) : (
          <div id="map" className={styles.map} />
        )}
        {selectedRoom ? (
          <RoomSelection
            key={selectedRoom.id}
            room={selectedRoom}
            onClose={() => {
              setSelectedRoom(null);
              setClusterRoomIds(null);
            }}
            getMap={getMap}
            mapControlsRef={mapControlsRef}
          />
        ) : (
          <RoomList
            lands={listLands}
            clusterIds={clusterRoomIds}
            rentType={rentType}
            onRentTypeChange={setRentType}
            onSelectRoom={handleSelectRoom}
            returnFocusRoomId={returnFocusRoomId}
            mapControlsRef={mapControlsRef}
          />
        )}
        <div ref={mapControlsRef} className={styles['map-controls']}>
          {!hasMapError && <RoomMapControls onZoom={(delta) => getMap()?.zoomBy(delta)} />}
        </div>
        {isSearchEmpty && <SearchEmptyState className={styles.empty} />}
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
