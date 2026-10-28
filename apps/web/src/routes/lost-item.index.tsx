import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';



import { dehydrate, keepPreviousData, QueryClient, useQuery } from '@tanstack/react-query';
import type { LostItemArticlesRequest } from 'api/articles/entity';
import { articleQueries } from 'api/articles/queries';
import LostItemList from 'components/Articles/components/LostItemList';
import LostItemPageLayout from 'components/Articles/components/LostItemPageLayout';
import Pagination from 'components/Articles/components/Pagination';
import { type LostItemParams, parseLostItemQuery } from 'components/Articles/utils/lostItemQuery';
import { selectLostItemPaginationData } from 'components/Articles/utils/selectArticlesData';
import { SSRLayout } from 'components/layout';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';


import styles from 'pages/lost-item/LostItemArticleListPage.module.scss';



function useLostItemParams(initialParams: LostItemParams) {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const mounted = useMount();

  if (!mounted) return initialParams;

  return parseLostItemQuery(routeQuery, initialParams);
}

function toLostItemArticlesRequest(params: LostItemParams): LostItemArticlesRequest {
  const { type, ...rest } = params;

  return {
    ...rest,
    ...(type ? { type } : {}),
  };
}

export default function LostItemArticleListPage({
  initialParams,
}: Awaited<ReturnType<typeof getPageData>>) {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const isLoggedIn = useIsLoggedIn();

  const params = useLostItemParams(initialParams);
  const apiParams = toLostItemArticlesRequest(params);

  const keywordFromQuery = (Array.isArray(routeQuery.keyword) ? routeQuery.keyword[0] : routeQuery.keyword) ?? '';
  const keyword = String(keywordFromQuery).trim();

  const isSearching = keyword.length > 0;

  const { data: lostItemData } = useQuery({
    ...articleQueries.lostItemList(isLoggedIn, apiParams),
    placeholderData: keepPreviousData,
    select: selectLostItemPaginationData,
  });

  const { data: searchData } = useQuery({
    ...articleQueries.lostItemSearch({
      query: keyword.trim(),
      page: params.page ?? 1,
      limit: 10,
    }),
    enabled: keyword.length > 0,
  });

  const articles = isSearching ? (searchData?.articles ?? []) : (lostItemData?.articles ?? []);
  const totalPageNum = isSearching ? (searchData?.total_page ?? 0) : (lostItemData?.paginationInfo?.total_page ?? 0);

  return (
    <LostItemPageLayout>
      <LostItemList articles={articles} />
      <div className={styles.pagination}>
        <Pagination totalPageNum={totalPageNum} />
      </div>
    </LostItemPageLayout>
  );
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (context, cacheControl, serverRequest) => {
    const queryClient = new QueryClient();
    const { search: query } = context;

    const fallback: LostItemParams = {
      page: 1,
      type: null,
      category: [],
      foundStatus: 'ALL',
      sort: 'LATEST',
      author: 'ALL',
    };

    const params = parseLostItemQuery(query, fallback);

    const apiParams = toLostItemArticlesRequest(params);

    await queryClient.prefetchQuery(articleQueries.lostItemList(serverRequest.isLoggedIn, apiParams));

    if (!serverRequest.isLoggedIn) {
      cacheControl.enablePublicCache();
    }

    return {
        dehydratedState: dehydrate(queryClient),
        initialParams: params,
      };
  }));

export const Route = createFileRoute('/lost-item/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <LostItemArticleListPage {...props} />;
  return <SSRLayout>{page}</SSRLayout>;
}
