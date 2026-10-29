import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderDeliveryOutsidePage from 'components/Order/OrderDelivery/OrderDeliveryOutsidePage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

interface Props {
  isDesktop: boolean;
}

function OrderDeliveryOutsideRoute({ isDesktop }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="주소 상세" />
      {isDesktop ? <DesktopNotice /> : <OrderDeliveryOutsidePage />}
    </>
  );
}

export default OrderDeliveryOutsideRoute;

// 배달지 선택은 사용자별 화면이라 공개 캐시를 켜지 않는다. 첫 화면은 검색 안내만 있어 받아 둘 데이터가 없다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, (_context, _cacheControl, serverRequest) => ({
      isDesktop: serverRequest.device !== 'mobile',
    })),
  );

export const Route = createFileRoute('/order/delivery/outside/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderDeliveryOutsideRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
