import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderPaymentReturnPage, { type PaymentReturnParams } from 'components/Order/OrderPaymentReturnPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput, type PageRequest } from 'utils/ssr/pageData';

interface Props {
  isDesktop: boolean;
  payment: PaymentReturnParams | null;
}

const getQueryValue = (value: unknown) => (typeof value === 'string' && value ? value : null);

// order처럼 Toss successUrl의 파라미터가 하나라도 없으면 승인하지 않고 안내만 그린다
const parsePaymentParams = (query: PageRequest['search']): PaymentReturnParams | null => {
  const orderType = getQueryValue(query.orderType);
  const orderId = getQueryValue(query.orderId);
  const paymentKey = getQueryValue(query.paymentKey);
  const amount = getQueryValue(query.amount);

  if (!orderType || !orderId || !paymentKey || !amount) return null;

  return { orderType, orderId, paymentKey, amount };
};

function OrderCheckoutReturnRoute({ isDesktop, payment }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      {/* order의 결제 승인 화면은 앱 레이아웃 밖이라 헤더가 없다(결제 중·파라미터 부족 모두) */}
      {isDesktop && <StoreMobileHeader title="주문" />}
      {isDesktop ? <DesktopNotice /> : <OrderPaymentReturnPage payment={payment} />}
    </>
  );
}

export default OrderCheckoutReturnRoute;

// 결제 승인은 사용자별 화면이라 공개 캐시를 켜지 않는다. 승인 요청은 클라이언트에서 한 번만 보낸다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, (context, _cacheControl, serverRequest) => ({
      isDesktop: serverRequest.device !== 'mobile',
      payment: parsePaymentParams(context.search),
    })),
  );

export const Route = createFileRoute('/order/checkout/return/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderCheckoutReturnRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
