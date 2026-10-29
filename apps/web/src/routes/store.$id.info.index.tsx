import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreInfoPage from 'components/Store/mobile/StoreInfoPage';
import ROUTES from 'static/routes';
import { loadPageData, validatePageInput, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageData';
import { isNotFoundKoinError } from 'utils/ts/isr';

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

export default StoreInfoRoute;

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, cacheControl, serverRequest) => {
      const id = context.params.id;
      if (!id) throw notFound();

      // 모바일 전용 화면. 데스크톱은 서버가 확정한 기기 값으로 기존 화면에 보낸다
      if (serverRequest.device !== 'mobile') {
        throw redirect({ href: ROUTES.StoreDetail({ id }), statusCode: 302 });
      }

      // 상점 정보를 서버에서 받아 본문까지 렌더한다(클라이언트는 같은 쿼리 키로 캐시를 이어받는다)
      const queryClient = new QueryClient();
      try {
        await queryClient.fetchQuery(storeMobileQueries.detail(id));
      } catch (error) {
        if (isNotFoundKoinError(error)) throw notFound();
        throw error;
      }

      cacheControl.enablePublicCache(STORE_PUBLIC_SSR_CACHE_CONTROL);

      return { id, dehydratedState: dehydrate(queryClient) };
    }),
  );

export const Route = createFileRoute('/store/$id/info/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <StoreInfoRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
