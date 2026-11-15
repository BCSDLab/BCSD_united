import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { MobileOnlyPage } from 'components/layout/ResponsivePage';
import StoreInfoPage from 'components/Store/mobile/StoreInfoPage';
import ROUTES from 'static/routes';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError } from 'utils/ts/isr';
import { parseQueryId } from 'utils/ts/parseServerSideParams';

interface Props {
  id: string;
}

function StoreInfoRoute({ id }: Props) {
  return (
    <>
      <MobilePageHeader title="상점 정보" />
      <StoreInfoPage id={id} />
    </>
  );
}

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const id = params.id;
  if (parseQueryId(id) === null) throw notFound();

  // 모바일 전용 화면. 모바일 화면 조건이 아니면 데스크톱 화면으로 보낸다
  if (!isMobileView(serverRequest.device)) {
    throw redirect({ href: ROUTES.StoreDetail({ id }), statusCode: 302 });
  }

  // 상점 정보를 미리 받아 본문까지 렌더한다
  try {
    await queryClient.fetchQuery(storeMobileQueries.detail(id));
  } catch (error) {
    if (isNotFoundKoinError(error)) throw notFound();
    throw error;
  }

  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  return { id };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/store/$id/info/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const { id, serverRequest } = Route.useLoaderData();

  return (
    <MobileOnlyPage device={serverRequest.device} desktopHref={ROUTES.StoreDetail({ id })}>
      <StoreInfoRoute id={id} />
    </MobileOnlyPage>
  );
}
