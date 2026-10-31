import { dehydrate, type DehydratedState, QueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { getCart } from 'api/order';
import type { CartResponse, OrderType } from 'api/order/entity';
import { orderQueries } from 'api/order/queries';
import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderCheckoutPage from 'components/Order/OrderCheckoutPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

interface Props {
  isDesktop: boolean;
  orderType: OrderType;
  dehydratedState?: DehydratedState;
}

// order처럼 DELIVERY가 아니면 포장 주문 화면으로 그린다
const parseOrderType = (value: unknown): OrderType => (value === 'DELIVERY' ? 'DELIVERY' : 'TAKE_OUT');

function OrderCheckoutRoute({ isDesktop, orderType }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="주문" />
      {isDesktop ? <DesktopNotice /> : <OrderCheckoutPage orderType={orderType} />}
    </>
  );
}

export default OrderCheckoutRoute;

// 결제(주문서)는 사용자별 화면이라 공개 캐시를 켜지 않는다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, _cacheControl, serverRequest) => {
      const orderType = parseOrderType(context.search.orderType);

      if (serverRequest.device !== 'mobile') {
        return { isDesktop: true, orderType };
      }

      // 로그인이면 order가 부르는 장바구니·학생 정보·배달기사님 요청 문구와, 장바구니의 상점으로
      // 가게 정보·입금 계좌와 배달 가능 여부(배달)를 서버에서 받아 본문까지 렌더한다.
      // 실패한 조회는 결과를 내리지 않고 클라이언트가 다시 조회한다
      const queryClient = new QueryClient();
      if (serverRequest.isLoggedIn) {
        const [cart] = await Promise.all([
          queryClient
            .fetchQuery({ ...orderQueries.cart(orderType, true), queryFn: () => getCart(orderType, true) })
            .catch((): CartResponse | null => null),
          queryClient.prefetchQuery(orderQueries.studentInfo(true)),
          queryClient.prefetchQuery(orderQueries.riderMessages(true)),
        ]);

        // 장바구니는 orderable_shop_id만 주는데 입금 계좌는 shop_id로 조회하는 상점 상세에 있어,
        // 주문 상점 상세에서 shop_id를 먼저 받은 뒤 상점 상세를 받는다
        const orderableShopId = cart?.orderable_shop_id ?? 0;
        if (orderableShopId > 0) {
          const [orderShop] = await Promise.all([
            queryClient.fetchQuery(storeMobileQueries.orderDetail(String(orderableShopId))).catch(() => null),
            orderType === 'DELIVERY' && queryClient.prefetchQuery(orderQueries.shopDeliveryInfo(orderableShopId)),
          ]);
          if (orderShop) await queryClient.prefetchQuery(storeMobileQueries.detail(String(orderShop.shop_id)));
        }
      }

      return { isDesktop: false, orderType, dehydratedState: dehydrate(queryClient) };
    }),
  );

export const Route = createFileRoute('/order/checkout/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderCheckoutRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
