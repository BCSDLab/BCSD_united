import { createFileRoute, useSearch, useParams, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';




import { dehydrate, QueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { reviewQueries } from 'api/review/queries';
import { storeMobileQueries } from 'api/storeMobile/queries';
import Layout, { SSRLayout } from 'components/layout';
import ReviewEditPage from 'components/Store/mobile/ReviewFormPage/ReviewEditPage';
import useStoreDetail from 'components/Store/StoreDetailPage/hooks/useStoreDetail';
import { useEditStoreReview } from 'components/Store/StoreReviewPage/hooks/useEditStoreReview';
import ReviewForm from 'components/Store/StoreReviewPage/ReviewForm/ReviewForm';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';
import useMount from 'utils/hooks/state/useMount';

import { isNotFoundKoinError } from 'utils/ts/isr';

interface Props {
  id: string;
  reviewId: string;
  isMobile: boolean;
}

function EditReviewComponent({ id, reviewId }: { id: string; reviewId: string }) {
  const isLoggedIn = useIsLoggedIn();
  const { storeDetail } = useStoreDetail(id);
  const { mutate } = useEditStoreReview(String(storeDetail.id), reviewId);
  const { data: initialData } = useSuspenseQuery(reviewQueries.detail(id, reviewId, isLoggedIn));

  return <ReviewForm storeDetail={storeDetail} mutate={mutate} initialData={initialData} />;
}

// 기존 데스크톱 화면. getPageData가 없던 때처럼 서버는 비워 두고 클라이언트에서만 그린다
function DesktopEditReview() {
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  const isMounted = useMount();
  const { id, reviewid } = routeQuery;

  const pageId = Array.isArray(id) ? id[0] : id;
  if (!isMounted || !pageId || !reviewid) return null;

  return <EditReviewComponent id={pageId} reviewId={String(reviewid)} />;
}

function EditReviewPage({ id, reviewId, isMobile }: Props) {
  if (!isMobile) return <DesktopEditReview />;

  return <ReviewEditPage id={id} reviewId={reviewId} />;
}





export default EditReviewPage;

// 로그인 필수 화면이라 공용 캐시를 켜지 않는다(loadPageData 기본값 private)
const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async (context, _cacheControl, serverRequest) => {
    const { id, reviewid: reviewId } = context.params;
    if (!id || !reviewId) throw notFound();

    // 데스크톱은 기존처럼 클라이언트에서 그린다
    if (serverRequest.device !== 'mobile') {
      return { id, reviewId, isMobile: false };
    }

    // 모바일은 상점명과 기존 리뷰를 서버에서 받아 본문까지 렌더한다(클라이언트는 같은 쿼리 키로 캐시를 이어받는다)
    const queryClient = new QueryClient();
    try {
      await Promise.all([
        queryClient.fetchQuery(storeMobileQueries.detail(id)),
        queryClient.fetchQuery(storeMobileQueries.reviewDetail(id, reviewId)),
      ]);
    } catch (error) {
      if (isNotFoundKoinError(error)) throw notFound();
      throw error;
    }

    return { id, reviewId, isMobile: true, dehydratedState: dehydrate(queryClient) };
  }));

export const Route = createFileRoute('/store/review/edit/$id/$reviewid/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  staticData: { requireAuth: true },
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <EditReviewPage {...props} />;
  return props.isMobile ? <SSRLayout mobileHeader="page">{page}</SSRLayout> : <Layout>{page}</Layout>;
}
