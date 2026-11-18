import { createFileRoute, useSearch, useParams, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { storeMobileQueries } from 'api/storeMobile/queries';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { ResponsivePage } from 'components/layout/ResponsivePage';
import ReviewCreatePage from 'components/Store/mobile/ReviewFormPage';
import useStoreDetail from 'components/Store/StoreDetailPage/hooks/useStoreDetail';
import { useAddStoreReview } from 'components/Store/StoreReviewPage/hooks/useAddStoreReview';
import ReviewForm from 'components/Store/StoreReviewPage/ReviewForm/ReviewForm';
import { isMobileView } from 'utils/hooks/layout/useMobileView';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import { isNotFoundKoinError } from 'utils/ts/edgeCache';

function AddReviewComponent({ id }: { id: string }) {
  const { storeDetail } = useStoreDetail(id);
  const { mutate } = useAddStoreReview(String(storeDetail.id));

  return <ReviewForm storeDetail={storeDetail} mutate={mutate} initialData={{}} />;
}

// 기존 데스크톱 화면. getPageData가 없던 때처럼 서버는 비워 두고 클라이언트에서만 그린다
function DesktopAddReview() {
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };
  const isMounted = useMount();
  const { id } = routeQuery;

  const pageId = Array.isArray(id) ? id[0] : id;
  if (!isMounted || !pageId) return null;

  return <AddReviewComponent id={pageId} />;
}

// 로그인 필수 화면이라 공용 캐시를 켜지 않는다(loadPageData 기본값 private)
const loadPage = definePageLoad(async ({ params, queryClient }, _cacheControl, serverRequest) => {
  const id = params.id;
  if (!id) throw notFound();

  // 데스크톱 화면은 기존처럼 브라우저에서 그린다
  if (!isMobileView(serverRequest.device)) {
    return { id };
  }

  // 모바일 화면은 상점명을 미리 받아 본문까지 렌더한다
  try {
    await queryClient.fetchQuery(storeMobileQueries.detail(id));
  } catch (error) {
    if (isNotFoundKoinError(error)) throw notFound();
    throw error;
  }

  return { id };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/store/review/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  staticData: { requireAuth: true },
  component: RouteComponent,
});

function RouteComponent() {
  const { id, serverRequest } = Route.useLoaderData();

  return (
    <ResponsivePage
      device={serverRequest.device}
      mobile={
        <>
          <MobilePageHeader title="리뷰 작성하기" />
          <ReviewCreatePage id={id} />
        </>
      }
      desktop={<DesktopAddReview />}
    />
  );
}
