import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreSearchPage from 'components/Store/mobile/StoreSearchPage';
import ROUTES from 'static/routes';
import { loadPageData, validatePageInput, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageData';

function StoreSearchRoute() {
  return (
    <>
      <MobilePageHeader background="gray" title="검색" />
      <StoreSearchPage />
    </>
  );
}

export default StoreSearchRoute;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, (_context, cacheControl, serverRequest) => {
      // 모바일 전용 화면. 데스크톱은 서버가 확정한 기기 값으로 기존 화면에 보낸다
      if (serverRequest.device !== 'mobile') {
        throw redirect({ href: ROUTES.Store(), statusCode: 302 });
      }

      cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

      return {};
    }),
  );

export const Route = createFileRoute('/store/search/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <StoreSearchRoute />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
