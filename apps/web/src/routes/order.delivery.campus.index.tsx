import { dehydrate, type DehydratedState, QueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { CAMPUS_ADDRESS_CATEGORIES } from 'api/order/entity';
import { orderQueries } from 'api/order/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderDeliveryCampusPage from 'components/Order/OrderDelivery/OrderDeliveryCampusPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

interface Props {
  isDesktop: boolean;
  dehydratedState?: DehydratedState;
}

function OrderDeliveryCampusRoute({ isDesktop }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="주소 상세" />
      {isDesktop ? <DesktopNotice /> : <OrderDeliveryCampusPage />}
    </>
  );
}

export default OrderDeliveryCampusRoute;

// 배달지 선택은 사용자별 화면이라 공개 캐시를 켜지 않는다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (_context, _cacheControl, serverRequest) => {
      if (serverRequest.device !== 'mobile') {
        return { isDesktop: true };
      }

      // order가 부르는 교내 배달지 분류 3개를 서버에서 받아 본문까지 렌더한다.
      // 실패하면 결과를 내리지 않고 클라이언트가 다시 조회한다
      const queryClient = new QueryClient();
      await Promise.all(
        CAMPUS_ADDRESS_CATEGORIES.map((filter) =>
          queryClient.prefetchQuery(orderQueries.campusDeliveryAddresses(filter)),
        ),
      );

      return { isDesktop: false, dehydratedState: dehydrate(queryClient) };
    }),
  );

export const Route = createFileRoute('/order/delivery/campus/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderDeliveryCampusRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
