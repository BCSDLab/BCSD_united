import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreSearchPage from 'components/Store/mobile/StoreSearchPage';
import ROUTES from 'static/routes';
import useMobileOnlyPage from 'utils/hooks/layout/useMobileOnlyPage';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';

function StoreSearchRoute() {
  return (
    <>
      <MobilePageHeader background="gray" title="검색" />
      <StoreSearchPage />
    </>
  );
}

const loadPage = definePageLoad((_context, cacheControl, serverRequest) => {
  // 모바일 전용 화면. 모바일 화면 조건(isMobileView)이 아니면 데스크톱 화면으로 보낸다
  if (!isMobileView(serverRequest.device)) {
    throw redirect({ href: ROUTES.Store(), statusCode: 302 });
  }

  cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/store/search/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  const { serverRequest } = Route.useLoaderData();
  useMobileOnlyPage(serverRequest.device, ROUTES.Store());

  return (
    <SSRLayout mobileHeader="page">
      <StoreSearchRoute />
    </SSRLayout>
  );
}
