import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { roomQueries } from 'api/room/queries';
import { SSRLayout } from 'components/layout';
import RoomList from 'components/Room/components/RoomList';
import useMarker from 'components/Room/RoomPage/hooks/useMarker';
import useNaverMap from 'components/Room/RoomPage/hooks/useNaverMap';
import useNaverMapScript from 'components/Room/RoomPage/hooks/useNaverMapScript';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useScrollToTop from 'utils/hooks/ui/useScrollToTop';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/RoomPage.module.scss';

const LOCATION = { latitude: 36.764617, longitude: 127.283154 };

function RoomPage() {
  const isMobile = useMediaQuery();
  const { data: roomList } = useQuery(roomQueries.list());
  const isMapLoaded = useNaverMapScript();
  const { getMap } = useNaverMap(LOCATION.latitude, LOCATION.longitude, isMapLoaded);
  useMarker({ getMap, roomList });
  useScrollToTop();

  return (
    <div className={styles.template}>
      <h1 className={isMobile ? styles.hidden : styles.title}>복덕방</h1>
      <div className={styles.content}>
        <div id="map" className={styles.map} />
        <RoomList lands={roomList?.lands} />
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

  return <SSRLayout>{page}</SSRLayout>;
}
