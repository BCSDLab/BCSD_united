import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { orderQueries } from 'api/order/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderListPage from 'components/Order/OrderListPage';
import { DEFAULT_ORDER_HISTORY_FILTER } from 'components/Order/OrderListPage/constants';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

interface Props {
  isDesktop: boolean;
}

function OrderListRoute({ isDesktop }: Props) {
  if (isDesktop) {
    return (
      <>
        <StoreMobileHeader title="주문 내역" />
        <DesktopNotice />
      </>
    );
  }

  return (
    <>
      <OrderViewport />
      <StoreMobileHeader title="주문 내역" background="gray" />
      <OrderListPage />
    </>
  );
}

// 주문 내역은 사용자별 화면이라 공개 캐시를 켜지 않는다
const loadPage = definePageLoad(async ({ queryClient }, _cacheControl, serverRequest) => {
  if (serverRequest.device !== 'mobile') {
    return { isDesktop: true };
  }

  // 로그인이면 order가 처음 부르는 두 요청(지난 주문 첫 페이지·준비 중 주문)을 미리 받아 본문까지 렌더한다.
  // 실패하면 결과를 내리지 않고 클라이언트가 다시 조회한다
  if (serverRequest.isLoggedIn) {
    await Promise.all([
      queryClient.prefetchInfiniteQuery(orderQueries.orderHistory(DEFAULT_ORDER_HISTORY_FILTER, true)),
      queryClient.prefetchQuery(orderQueries.inProgressOrders(true)),
    ]);
  }

  return { isDesktop: false };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/orders/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderListRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
