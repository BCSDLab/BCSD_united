import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderShopReviewsPage from 'components/Order/OrderShopReviewsPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { storeReviewsQueries } from 'components/Store/mobile/StoreReviewsPage/queries';
import { parseReviewSort } from 'components/Store/mobile/StoreReviewsPage/utils/reviewSort';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError } from 'utils/ts/isr';

type Props = { isDesktop: true; shopId?: undefined } | { isDesktop: false; shopId: string };

function OrderShopReviewsRoute({ isDesktop, shopId }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="리뷰" background="white" />
      {isDesktop ? <DesktopNotice /> : <OrderShopReviewsPage shopId={shopId} />}
    </>
  );
}

const loadPage = definePageLoad(async ({ params, search, queryClient }, cacheControl, serverRequest) => {
  const id = params.id;
  if (!id) throw notFound();

  if (serverRequest.device !== 'mobile') {
    cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

    return { isDesktop: true as const };
  }

  // URL의 id는 주문 가능 상점 번호(orderable_shop_id)다. 요약의 일반 상점 번호(shop_id)로 리뷰·상점 정보를 조회한다
  const { isLoggedIn } = serverRequest;
  const sort = parseReviewSort(search.sort);
  let shopId: string;
  try {
    const summary = await queryClient.fetchQuery(storeMobileQueries.orderSummary(id));
    shopId = String(summary.shop_id);

    // 상점명·리뷰 통계(최신순)·선택한 정렬의 목록을 미리 받아 본문까지 렌더한다(상점 리뷰 화면과 같은 구성).
    // 리뷰 요청은 만료된 access 쿠키로 실패할 수 있어 실패해도 페이지는 그리고 화면이 다시 받는다
    await Promise.all([
      queryClient.fetchQuery(storeMobileQueries.detail(shopId)),
      queryClient.prefetchQuery(storeMobileQueries.reviewList(shopId, 'LATEST', isLoggedIn)),
      sort !== 'LATEST' ? queryClient.prefetchQuery(storeMobileQueries.reviewList(shopId, sort, isLoggedIn)) : null,
      isLoggedIn ? queryClient.prefetchQuery(storeReviewsQueries.myReviews(shopId, sort, isLoggedIn)) : null,
    ]);
  } catch (error) {
    if (isNotFoundKoinError(error)) throw notFound();
    throw error;
  }

  if (!isLoggedIn) cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  return { isDesktop: false as const, shopId };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/shops/$id/reviews/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderShopReviewsRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
