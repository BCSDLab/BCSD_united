import { useEffect } from 'react';
import {
  createFileRoute,
  useNavigate,
  useRouter,
  useSearch,
  useParams,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import ReportForm from 'components/Articles/LostItemDetailPage/components/ReportForm';
import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

import styles from 'pages/lost-item/report/[id]/ReportPage.module.scss';

function ReportPage({ id }: { id: string }) {
  const router = useRouter();

  const handleClose = () => {
    router.history.back();
  };

  return (
    <>
      <MobilePageHeader title="게시글 신고하기" />
      <div className={styles['report-page']}>
        <ReportForm articleId={Number(id)} onClose={handleClose} isModal={false} />
      </div>
    </>
  );
}

export default function ReportPageWrapper() {
  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };
  const { id } = routeQuery;
  const isMobile = useMediaQuery();
  const mounted = useMount();

  // 서버가 이미 걸러내지만, 창 크기를 줄여 모바일 폭이 된 뒤 넓히는 경우를 위해 남긴다.
  useEffect(() => {
    if (mounted && !isMobile && typeof id === 'string') {
      routeNavigate({ href: ROUTES.LostItemDetail({ id }), replace: true });
    }
  }, [mounted, isMobile, id, routeNavigate]);

  if (!id || Array.isArray(id)) {
    return null;
  }

  return <ReportPage id={id} />;
}

// 신고하기는 모바일 전용 화면이기에 데스크톱에서는 게시물 상세로 리다이랙션한다
const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, (context, _cacheControl, serverRequest) => {
      const { id } = context.params;

      if (!id) {
        throw notFound();
      }

      if (serverRequest.device !== 'mobile') {
        throw redirect({ href: ROUTES.LostItemDetail({ id }), statusCode: 302 });
      }

      return {};
    }),
  );

export const Route = createFileRoute('/lost-item/report/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const page = <ReportPageWrapper />;

  return <Layout mobileHeader="page">{page}</Layout>;
}
