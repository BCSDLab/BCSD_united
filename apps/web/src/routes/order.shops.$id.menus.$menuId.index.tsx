import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { orderQueries } from 'api/order/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderMenuDetailPage from 'components/Order/OrderMenuDetailPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError } from 'utils/ts/isr';

interface Props {
  id: string;
  menuId: string;
  isDesktop: boolean;
}

function OrderMenuDetailRoute({ id, menuId, isDesktop }: Props) {
  // 모바일은 이미지 위에 겹치는 상세 전용 헤더를 본문에서 그린다.
  if (!isDesktop) {
    return (
      <>
        <OrderViewport />
        <OrderMenuDetailPage shopId={id} menuId={menuId} />
      </>
    );
  }

  return (
    <>
      <StoreMobileHeader title="주변상점" />
      <DesktopNotice />
    </>
  );
}

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const { id, menuId } = params;
  if (!id || !menuId) throw notFound();

  if (serverRequest.device !== 'mobile') {
    cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

    return { id, menuId, isDesktop: true };
  }

  // order가 부르는 메뉴 상세만 미리 받아 본문까지 렌더한다(order는 이 화면에서 장바구니를 조회하지 않는다).
  // 편집 모드(?editCartItemId)의 장바구니 항목 옵션은 화면이 조회한다
  try {
    await queryClient.fetchQuery(orderQueries.menuDetail(id, menuId));
  } catch (error) {
    if (isNotFoundKoinError(error)) {
      throw notFound();
    }
    throw error;
  }

  if (!serverRequest.isLoggedIn) {
    cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);
  }

  return { id, menuId, isDesktop: false };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/shops/$id/menus/$menuId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderMenuDetailRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
