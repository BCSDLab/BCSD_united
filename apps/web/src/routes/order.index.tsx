import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { orderQueries } from 'api/order/queries';
import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderHomePage from 'components/Order/OrderHomePage';
import { DEFAULT_ORDER_HOME_CONDITIONS, getOrderableShopsParams } from 'components/Order/OrderHomePage/constants';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';

interface Props {
  isDesktop: boolean;
}

function OrderHomeRoute({ isDesktop }: Props) {
  if (isDesktop) {
    return (
      <>
        <StoreMobileHeader title="주문" />
        <DesktopNotice />
      </>
    );
  }

  return (
    <>
      <OrderViewport />
      <StoreMobileHeader title="주문" background="gray" />
      <OrderHomePage />
    </>
  );
}

// 주문 홈은 공개 화면이라 비로그인이면 다른 상점 목록과 같은 공개 캐시를 켠다(로그인이면 loadPageData가 무시한다)
const loadPage = definePageLoad(async ({ queryClient }, cacheControl, serverRequest) => {
  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  if (serverRequest.device !== 'mobile') {
    return { isDesktop: true };
  }

  // order가 처음 부르는 두 요청(카테고리·기본 조건 상점 목록)을 미리 받아 본문까지 렌더한다.
  // 실패하면 결과를 내리지 않고 클라이언트가 다시 조회한다
  await Promise.all([
    queryClient.prefetchQuery(storeMobileQueries.categories()),
    queryClient.prefetchQuery(orderQueries.orderableShops(getOrderableShopsParams(DEFAULT_ORDER_HOME_CONDITIONS))),
  ]);

  return { isDesktop: false };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderHomeRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
