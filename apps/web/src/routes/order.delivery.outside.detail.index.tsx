import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';



import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderDeliveryOutsideDetailPage from 'components/Order/OrderDelivery/OrderDeliveryOutsideDetailPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';


interface Props {
  isDesktop: boolean;
  roadAddress: string;
}


function OrderDeliveryOutsideDetailRoute({ isDesktop, roadAddress }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="주소 상세" />
      {isDesktop ? <DesktopNotice /> : <OrderDeliveryOutsideDetailPage roadAddress={roadAddress} />}
    </>
  );
}

export default OrderDeliveryOutsideDetailRoute;

// 배달지 선택은 사용자별 화면이라 공개 캐시를 켜지 않는다.
// order는 도로명 주소를 location.state로 넘긴다. 여기서는 쿼리(roadAddress)로 받아 서버가 주소까지 렌더한다(규칙 10)
const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, (context, _cacheControl, serverRequest) => {
    const { roadAddress } = context.search;

    return {
      isDesktop: serverRequest.device !== 'mobile',
      roadAddress: typeof roadAddress === 'string' ? roadAddress : '',
    };
  }));

export const Route = createFileRoute('/order/delivery/outside/detail/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderDeliveryOutsideDetailRoute {...props} />;
  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
