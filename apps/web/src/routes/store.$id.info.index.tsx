import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import { SSRLayout } from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import StoreInfoPage from 'components/Store/mobile/StoreInfoPage';
import ROUTES from 'static/routes';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad, STORE_PUBLIC_SSR_CACHE_CONTROL } from 'utils/ssr/pageLoader';
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

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const id = params.id;
  if (!id) throw notFound();

  // 모바일 전용 화면. 데스크톱은 확정된 기기 값으로 기존 화면에 보낸다
  if (serverRequest.device !== 'mobile') {
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
  const props = Route.useLoaderData();
  const page = <StoreInfoRoute {...props} />;

  return <SSRLayout mobileHeader="page">{page}</SSRLayout>;
}
