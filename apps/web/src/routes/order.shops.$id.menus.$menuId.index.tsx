import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { orderQueries } from 'api/order/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderMenuDetailPage from 'components/Order/OrderMenuDetailPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageData';
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

export default OrderMenuDetailRoute;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, cacheControl, serverRequest) => {
      const { id, menuId } = context.params;
      if (!id || !menuId) throw notFound();

      if (serverRequest.device !== 'mobile') {
        cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

        return { id, menuId, isDesktop: true };
      }

      // order가 부르는 메뉴 상세만 서버에서 받아 본문까지 렌더한다(order는 이 화면에서 장바구니를 조회하지 않는다).
      // 편집 모드(?editCartItemId)의 장바구니 항목 옵션은 클라이언트가 조회한다
      const queryClient = new QueryClient();
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

      return { id, menuId, isDesktop: false, dehydratedState: dehydrate(queryClient) };
    }),
  );

export const Route = createFileRoute('/order/shops/$id/menus/$menuId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderMenuDetailRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
