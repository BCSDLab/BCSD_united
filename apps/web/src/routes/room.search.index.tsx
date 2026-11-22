import { useRef } from 'react';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { roomQueries } from 'api/room/queries';
import SearchIcon from 'assets/svg/Articles/search.svg';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { MobileOnlyPage } from 'components/layout/ResponsivePage';
import RoomCardContent from 'components/Room/components/RoomCard/RoomCardContent';
import RoomSearchField from 'components/Room/components/RoomSearchField';
import useRoomSearch from 'components/Room/RoomPage/hooks/useRoomSearch';
import HeaderIconButton from 'components/ui/PageHeader/HeaderIconButton';
import SearchEmptyState from 'components/ui/SearchEmptyState';
import ROUTES from 'static/routes';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import useGoBack from 'utils/hooks/routing/useGoBack';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { ROOM_ISR_REVALIDATE_SECONDS, withStaticFetchRetry } from 'utils/ts/isr';

import styles from 'pages/room/search/RoomSearchPage.module.scss';

function RoomSearchPage() {
  const { rooms, results, keyword, searchRooms } = useRoomSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const goBack = useGoBack();

  return (
    <>
      <MobilePageHeader
        title="복덕방"
        className={styles.header}
        onBack={() => goBack(ROUTES.Room())}
        rightAction={
          <HeaderIconButton
            className={styles['search-action']}
            aria-label="검색창으로 이동"
            onClick={() => inputRef.current?.focus()}
          >
            <SearchIcon aria-hidden />
          </HeaderIconButton>
        }
      />
      <main className={styles.content}>
        <div className={styles.search}>
          <RoomSearchField key={keyword} keyword={keyword} rooms={rooms} onSearch={searchRooms} inputRef={inputRef} />
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
                    <Link to={ROUTES.RoomDetail({ id: String(room.id) })} className={styles.result}>
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

const loadPage = definePageLoad(async ({ queryClient }, cacheControl, serverRequest) => {
  if (!isMobileView(serverRequest.device)) throw redirect({ href: ROUTES.Room(), statusCode: 302 });
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

  return (
    <MobileOnlyPage device={serverRequest.device} desktopHref={ROUTES.Room()} className={styles.layout}>
      <RoomSearchPage />
    </MobileOnlyPage>
  );
}
