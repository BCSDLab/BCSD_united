import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import OrderViewport from 'components/Order/common/OrderViewport';
import DesktopNotice from 'components/Order/DesktopNotice';
import OrderShopInfoPage from 'components/Order/OrderShopInfoPage';
import StoreMobileHeader from 'components/Store/mobile/common/StoreMobileHeader';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError } from 'utils/ts/isr';

interface Props {
  id: string;
  isDesktop: boolean;
}

function OrderShopInfoRoute({ id, isDesktop }: Props) {
  return (
    <>
      {!isDesktop && <OrderViewport />}
      <StoreMobileHeader title="상점 정보" background="white" />
      {isDesktop ? <DesktopNotice /> : <OrderShopInfoPage id={id} />}
    </>
  );
}

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const id = params.id;
  if (!id) throw notFound();

  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  if (serverRequest.device !== 'mobile') {
    return { id, isDesktop: true };
  }

  // order가 부르는 상점 상세(order/shop/{id}/detail)만 미리 받아 본문까지 렌더한다
  try {
    await queryClient.fetchQuery(storeMobileQueries.orderDetail(id));
  } catch (error) {
    if (isNotFoundKoinError(error)) throw notFound();
    throw error;
  }

  return { id, isDesktop: false };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/order/shops/$id/info/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <OrderShopInfoRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
