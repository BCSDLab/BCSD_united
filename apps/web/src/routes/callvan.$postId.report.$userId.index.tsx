import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { useEffect } from 'react';



import ReportPage from 'components/Callvan/components/ReportPage';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';



interface CallvanReportPageProps {
  postId: number;
  userId: number;
}

export default function CallvanReportPage({ postId, userId }: CallvanReportPageProps) {
  
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



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, (context) => {
  const postId = Number(context.params.postId);
  const userId = Number(context.params.userId);

  if (!postId || Number.isNaN(postId) || !userId || Number.isNaN(userId)) {
    throw notFound();
  }

  return {
      postId,
      userId,
    };
}));

export const Route = createFileRoute('/callvan/$postId/report/$userId/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  return <CallvanReportPage {...Route.useLoaderData()} />;
}
