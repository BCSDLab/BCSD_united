import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderCancelPage from 'components/Order/OrderCancelPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

interface Props {
  isDesktop: boolean;
  paymentId: number;
}

const parsePaymentId = (value: unknown) => {
  const paymentId = typeof value === 'string' ? Number(value) : Number.NaN;

  return Number.isInteger(paymentId) && paymentId > 0 ? paymentId : null;
};

function OrderCancelRoute({ isDesktop, paymentId }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="주문 취소하기" background="gray" />
      {isDesktop ? <DesktopNotice /> : <OrderCancelPage paymentId={paymentId} />}
    </>
  );
}

// 주문 취소는 사용자별 화면이라 공개 캐시를 켜지 않는다. order는 이 화면에서 조회 요청을 보내지 않는다
const loadPage = definePageLoad(({ params }, _cacheControl, serverRequest) => {
  const paymentId = parsePaymentId(params.paymentId);
  if (!paymentId) throw notFound();

  return { isDesktop: serverRequest.device !== 'mobile', paymentId };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/cancel/$paymentId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderCancelRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
