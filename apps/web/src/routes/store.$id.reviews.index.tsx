import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreReviewsPage from 'components/Store/mobile/StoreReviewsPage';
import { storeReviewsQueries } from 'components/Store/mobile/StoreReviewsPage/queries';
import { parseReviewSort } from 'components/Store/mobile/StoreReviewsPage/utils/reviewSort';
import ROUTES from 'static/routes';
import { loadPageData, validatePageInput, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageData';
import { isNotFoundKoinError } from 'utils/ts/isr';

interface Props {
  id: string;
}

function StoreReviewsRoute({ id }: Props) {
  return (
    <>
      <MobilePageHeader title="리뷰" />
      <StoreReviewsPage id={id} />
    </>
  );
}

export default StoreReviewsRoute;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, cacheControl, serverRequest) => {
      const id = context.params.id;
      if (!id) throw notFound();

      // 모바일 전용 화면. 데스크톱은 서버가 확정한 기기 값으로 기존 화면에 보낸다
      if (serverRequest.device !== 'mobile') {
        throw redirect({ href: ROUTES.StoreDetail({ id }), statusCode: 302 });
      }

      // 상점명·리뷰 통계(최신순)·선택한 정렬의 목록을 서버에서 받아 본문까지 렌더한다.
      // 로그인이면 내 리뷰도 받는다. 만료 등으로 실패해도 페이지는 그리고 클라이언트가 다시 받는다(prefetchQuery)
      const { isLoggedIn } = serverRequest;
      const sort = parseReviewSort(context.search.sort);
      const queryClient = new QueryClient();
      try {
        await Promise.all([
          queryClient.fetchQuery(storeMobileQueries.detail(id)),
          // 리뷰 요청에는 요청 쿠키가 실린다. 만료·무효 access 쿠키면 401인데 서버는 refresh를 못 하므로 실패해도 넘어간다
          queryClient.prefetchQuery(storeMobileQueries.reviewList(id, 'LATEST', isLoggedIn)),
          sort !== 'LATEST' ? queryClient.prefetchQuery(storeMobileQueries.reviewList(id, sort, isLoggedIn)) : null,
          isLoggedIn ? queryClient.prefetchQuery(storeReviewsQueries.myReviews(id, sort, isLoggedIn)) : null,
        ]);
      } catch (error) {
        if (isNotFoundKoinError(error)) throw notFound();
        throw error;
      }

      if (!isLoggedIn) cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

      return { id, dehydratedState: dehydrate(queryClient) };
    }),
  );

export const Route = createFileRoute('/store/$id/reviews/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <StoreReviewsRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
