import { dehydrate, keepPreviousData, QueryClient, useQuery } from '@tanstack/react-query';
import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { articleQueries } from 'api/articles/queries';
import ArticlesPageLayout from 'components/Articles/ArticlesPage';
import ArticleList from 'components/Articles/components/ArticleList';
import ArticlesHeader from 'components/Articles/components/ArticlesHeader';
import MobileArticleSearchButton from 'components/Articles/components/MobileArticleSearchButton';
import MobileArticleTabMenu from 'components/Articles/components/MobileArticleTabMenu';
import Pagination from 'components/Articles/components/Pagination';
import { createArticlesWithNewSelector } from 'components/Articles/utils/selectArticlesData';
import HomeLayout from 'components/layout/HomeLayout';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

const DEFAULT_BOARD_ID = 4;

function usePageParams(initialPage: string) {
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const mounted = useMount();

  if (!mounted) return initialPage;
  const page = routeQuery.page;

  return typeof page === 'string' ? page : initialPage;
}

function useBoardIdParams(initialBoardId: number) {
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

  const mounted = useMount();

  if (!mounted) return initialBoardId;
  const boardId = routeQuery.boardId;

  return typeof boardId === 'string' ? Number(boardId) : initialBoardId;
}

export default function ArticleListPage({
  initialPage,
  initialBoardId,
  serverNow,
}: Awaited<ReturnType<typeof getPageData>>) {
  const isLoggedIn = useIsLoggedIn();
  const paramsPage = usePageParams(initialPage);
  const boardId = useBoardIdParams(initialBoardId);

  const { data: articlesData } = useQuery({
    ...articleQueries.list(isLoggedIn, paramsPage, boardId),
    placeholderData: keepPreviousData,
    select: createArticlesWithNewSelector(serverNow),
  });

  const articles = articlesData?.articles ?? [];
  const paginationInfo = articlesData?.paginationInfo ?? {
    total_count: 0,
    total_page: 0,
    current_count: 0,
    current_page: 0,
  };

  return (
    <ArticlesPageLayout
      mobileTabMenu={
        <>
          <MobileArticleTabMenu currentBoardId={boardId} />
          <MobileArticleSearchButton />
        </>
      }
    >
      <ArticlesHeader />
      <ArticleList articles={articles} />
      <Pagination totalPageNum={paginationInfo.total_page} />
    </ArticlesPageLayout>
  );
}

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, cacheControl, serverRequest) => {
      const { search: query } = context;
      const pageNumber = typeof query.page === 'string' ? query.page : '1';
      const boardId = typeof query.boardId === 'string' ? Number(query.boardId) : DEFAULT_BOARD_ID;

      const queryClient = new QueryClient();

      const prefetchPromises = [
        queryClient.prefetchQuery(articleQueries.hot()),
        queryClient.prefetchQuery(articleQueries.list(serverRequest.isLoggedIn, pageNumber, boardId)),
      ];

      await Promise.all(prefetchPromises);

      if (!serverRequest.isLoggedIn) {
        cacheControl.enablePublicCache();
      }

      return {
        dehydratedState: dehydrate(queryClient),
        initialPage: pageNumber,
        serverNow: new Date().toISOString(),
        initialBoardId: boardId,
      };
    }),
  );

export const Route = createFileRoute('/articles/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <ArticleListPage {...props} />;

  return <HomeLayout whiteMobileBg>{page}</HomeLayout>;
}
