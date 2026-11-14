import { useEffect } from 'react';
import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import ReportPage from 'components/Callvan/components/ReportPage';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

interface CallvanReportPageProps {
  postId: number;
  userId: number;
}

function CallvanReportPage({ postId, userId }: CallvanReportPageProps) {
  const routeNavigate = useNavigate();

  const isMobile = useMediaQuery();
  const mounted = useMount();

  useEffect(() => {
    if (mounted && !isMobile) {
      routeNavigate({ href: ROUTES.Main(), replace: true });
    }
  }, [mounted, isMobile, routeNavigate]);

  if (mounted && !isMobile) {
    return null;
  }

  return <ReportPage postId={postId} reportedUserId={userId} />;
}

const loadPage = definePageLoad(({ params }) => {
  const postId = Number(params.postId);
  const userId = Number(params.userId);

  if (!postId || Number.isNaN(postId) || !userId || Number.isNaN(userId)) {
    throw notFound();
  }

  return {
    postId,
    userId,
  };
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/callvan/$postId/report/$userId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  component: RouteComponent,
});

function RouteComponent() {
  return <CallvanReportPage {...Route.useLoaderData()} />;
}
