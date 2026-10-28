import { createFileRoute, useNavigate, useSearch, useParams, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { useEffect, useState } from 'react';



import { dehydrate, QueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { CallvanListRequest } from 'api/callvan/entity';
import { callvanQueries, callvanQueryKeys } from 'api/callvan/queries';
import CallvanList from 'components/Callvan/components/CallvanList';
import CallvanPageLayout from 'components/Callvan/components/CallvanPageLayout';
import { type CallvanParams, parseCallvanQuery } from 'components/Callvan/utils/callvanQuery';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';
import useInfiniteScroll from 'utils/hooks/ui/useInfiniteScroll';


import listStyles from 'components/Callvan/components/CallvanList/CallvanList.module.scss';

const DEFAULT_PARAMS: CallvanParams = {
  page: 1,
  sort: 'LATEST_DESC',
  statuses: [],
  departures: [],
  arrivals: [],
  title: '',
  author: 'ALL',
  joined: false,
};

function toCallvanApiParams(params: CallvanParams): Omit<CallvanListRequest, 'page' | 'limit'> {
  return {
    sort: params.sort,
    ...(params.statuses.length > 0 ? { statuses: params.statuses } : {}),
    ...(params.departures.length > 0 ? { departures: params.departures } : {}),
    ...(params.arrivals.length > 0 ? { arrivals: params.arrivals } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.author !== 'ALL' ? { author: params.author } : {}),
    ...(params.joined ? { joined: true } : {}),
  };
}



function useCallvanParams(initialParams: CallvanParams): CallvanParams {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const mounted = useMount();

  if (!mounted) return initialParams;

  return parseCallvanQuery(routeQuery, DEFAULT_PARAMS);
}

export default function CallvanPage({ initialParams }: Awaited<ReturnType<typeof getPageData>>) {
  
  const routeNavigate = useNavigate();
  
  
  const isMobile = useMediaQuery();
  const mounted = useMount();

  // 서버가 이미 걸러내지만, 창 크기를 줄여 모바일 폭이 된 뒤 넓히는 경우를 위해 남긴다.
  useEffect(() => {
    if (mounted && !isMobile) {
      routeNavigate({ href: ROUTES.Main(), replace: true });
    }
  }, [mounted, isMobile, routeNavigate]);

  const params = useCallvanParams(initialParams);

  return <CallvanContent key={params.title} params={params} />;
}

interface CallvanContentProps {
  params: CallvanParams;
}

function CallvanContent({ params }: CallvanContentProps) {
  const [searchTitle, setSearchTitle] = useState(params.title);
  const isLoggedIn = useIsLoggedIn();
  const apiParams = toCallvanApiParams(params);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    ...callvanQueries.infiniteList(apiParams, isLoggedIn),
    enabled: isLoggedIn,
  });

  const posts = data?.pages.flatMap((page) => page.posts) ?? [];

  const scrollTriggerRef = useInfiniteScroll(fetchNextPage, hasNextPage, isFetchingNextPage);

  return (
    <CallvanPageLayout
      statuses={params.statuses}
      departures={params.departures}
      arrivals={params.arrivals}
      sort={params.sort}
      author={params.author}
      joined={params.joined}
      title={searchTitle}
      onTitleChange={setSearchTitle}
    >
      <CallvanList posts={posts} />

      {isFetchingNextPage && (
        <div className={listStyles['loading-indicator']}>
          <span className={listStyles['loading-indicator__text']}>불러오는 중...</span>
        </div>
      )}

      <div ref={scrollTriggerRef} className={listStyles['scroll-trigger']} />
    </CallvanPageLayout>
  );
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (context, _cacheControl, serverRequest) => {
  // 모바일 전용 화면이다. 데스크톱은 서버에서 바로 돌려보낸다. 클라이언트에서 판정하면
  // 서버가 페이지 전체를 그린 뒤 마운트 직후 통째로 버리게 된다.
  if (serverRequest.device !== 'mobile') {
    throw redirect({ href: ROUTES.Main(), statusCode: 302 });
  }

  const queryClient = new QueryClient();
  const { search: query } = context;

  const params = parseCallvanQuery(query, DEFAULT_PARAMS);
  const apiParams = toCallvanApiParams(params);

  const { isLoggedIn } = serverRequest;

  try {
    await Promise.all([
      queryClient.prefetchInfiniteQuery(callvanQueries.infiniteList(apiParams, isLoggedIn)),
      isLoggedIn
        ? queryClient.prefetchQuery(callvanQueries.notifications(isLoggedIn))
        : queryClient.setQueryData(callvanQueryKeys.notifications(isLoggedIn), []),
    ]);
  } catch (error) {
    console.error('[SSR] callvan prefetch failed:', error);
  }

  return {
      dehydratedState: dehydrate(queryClient),
      initialParams: params,
    };
}));

export const Route = createFileRoute('/callvan/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  return <CallvanPage {...Route.useLoaderData()} />;
}
