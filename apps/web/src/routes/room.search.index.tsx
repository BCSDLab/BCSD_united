import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { roomQueries } from 'api/room/queries';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { MobileOnlyPage } from 'components/layout/ResponsivePage';
import RoomCardContent from 'components/Room/components/RoomCard/RoomCardContent';
import RoomSearchField from 'components/Room/components/RoomSearchField';
import useRoomBack from 'components/Room/RoomPage/hooks/useRoomBack';
import useRoomSearch from 'components/Room/RoomPage/hooks/useRoomSearch';
import SearchEmptyState from 'components/ui/SearchEmptyState';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import { stringifySearch } from 'utils/routing/search';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/search/RoomSearchPage.module.scss';

function RoomSearchPage() {
  const { rooms, results, keyword, searchRooms } = useRoomSearch();
  const logger = useLogger();
  const handleBack = useRoomBack('room_list', ROUTES.Room());

  return (
    <>
      <MobilePageHeader title="복덕방" className={styles.header} onBack={handleBack} />
      <main className={styles.content}>
        <div className={styles.search}>
          <RoomSearchField key={keyword} keyword={keyword} rooms={rooms} onSearch={searchRooms} />
        </div>
        {results?.length === 0 ? (
          <SearchEmptyState className={styles.empty} />
        ) : (
          results && (
            <section className={styles.results} aria-label="건물 검색 결과">
              <p className={styles.count} aria-live="polite">
                전체({results.length})
              </p>
              <ul>
                {results.map((room) => (
                  <li key={room.id}>
                    <Link
                      to={ROUTES.RoomDetail({ id: String(room.id) })}
                      className={styles.result}
                      onClick={() =>
                        logger.actionEventClick({
                          event_name: 'DA1',
                          event_label: 'real_estate__room_list__room_detail__entry__click',
                          value: room.name,
                        })
                      }
                    >
                      <RoomCardContent room={room} showArrow />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        )}
      </main>
    </>
  );
}

const loadPage = definePageLoad(async ({ queryClient, search }, cacheControl, serverRequest) => {
  if (!isMobileView(serverRequest.device)) {
    throw redirect({ href: ROUTES.Room() + stringifySearch(search), statusCode: 302 });
  }
  await withStaticFetchRetry('room.list', () => queryClient.fetchQuery(roomQueries.list()));
  cacheControl.enablePublicCache(`public, s-maxage=${ROOM_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/room/search/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const { serverRequest } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <MobileOnlyPage
      device={serverRequest.device}
      desktopHref={ROUTES.Room() + stringifySearch(search)}
      className={styles.layout}
    >
      <RoomSearchPage />
    </MobileOnlyPage>
  );
}
