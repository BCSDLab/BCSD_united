import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';





import { dehydrate, QueryClient } from '@tanstack/react-query';
import { orderQueries } from 'api/order/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderResultPage from 'components/Order/OrderResultPage';
import OrderResultHeader from 'components/Order/OrderResultPage/components/OrderResultHeader';
import ROUTES from 'static/routes';

import { isNotFoundKoinError } from 'utils/ts/isr';

// useNaverMapsLoaded가 붙이는 지도 스크립트와 같은 주소(미리 받기용)
const NAVER_MAPS_SCRIPT_URL = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${process.env.NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID}&submodules=geocoder`;

interface Props {
  isDesktop: boolean;
  paymentId: number;
}

const parsePaymentId = (value: unknown) => {
  const paymentId = typeof value === 'string' ? Number(value) : Number.NaN;

  return Number.isInteger(paymentId) && paymentId > 0 ? paymentId : null;
};


function OrderResultRoute({ isDesktop, paymentId }: Props) {
  const routeNavigate = useNavigate();

  // order 헤더: 결과 화면은 제목 없이 닫기 버튼으로 주문 홈에 간다(routeTitles에 없는 경로)
  const goToOrderHome = () => {
    routeNavigate({ href: ROUTES.OrderHome(), replace: true });
  };

  return (
    <>
      {!isDesktop && <OrderViewport />}
      {!isDesktop && (
        <>
          {/* order는 index.html에서 지도 스크립트를 바로 불러 첫 렌더 때 지오코더가 준비돼 있다.
              여기선 지도 로더(useNaverMapsLoaded)가 마운트 후 붙이므로, 같은 주소를 미리 받아 둬 지도·가게 위치를 일찍 그린다 */}
          <link rel="preload" href={NAVER_MAPS_SCRIPT_URL} as="script" />
          <link rel="preconnect" href="https://maps.apigw.ntruss.com" />
        </>
      )}
      <OrderResultHeader onClose={goToOrderHome} />
      {isDesktop ? <DesktopNotice /> : <OrderResultPage paymentId={paymentId} />}
    </>
  );
}



export default OrderResultRoute;

// 주문 결과는 사용자별 화면이라 공개 캐시를 켜지 않는다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (context, _cacheControl, serverRequest) => {
    const paymentId = parsePaymentId(context.params.paymentId);
    if (!paymentId) throw notFound();

    if (serverRequest.device !== 'mobile') {
      return { isDesktop: true, paymentId };
    }

    // 로그인이면 order가 부르는 결제 정보만 서버에서 받아 본문까지 렌더한다.
    // 없는 주문(404)은 notFound로 응답하고, 그 밖의 실패는 결과를 내리지 않고 클라이언트가 다시 조회한다
    const queryClient = new QueryClient();
    if (serverRequest.isLoggedIn) {
      try {
        await queryClient.fetchQuery(orderQueries.paymentInfo(paymentId, true));
      } catch (error) {
        if (isNotFoundKoinError(error)) throw notFound();
      }
    }

    return { isDesktop: false, paymentId, dehydratedState: dehydrate(queryClient) };
  }));

export const Route = createFileRoute('/order/result/$paymentId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderResultRoute {...props} />;
  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
