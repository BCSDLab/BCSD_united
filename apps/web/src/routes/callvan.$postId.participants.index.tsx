import { Suspense, useEffect } from 'react';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { callvanQueries } from 'api/callvan/queries';
import ParticipantsList from 'components/Callvan/components/ParticipantsList';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';

export default function CallvanParticipantsPage({ postId }: Awaited<ReturnType<typeof getPageData>>) {
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

  return (
    <Suspense fallback={null}>
      <ParticipantsList postId={postId} />
    </Suspense>
  );
}

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) =>
    loadPageData(data, async (context, _cacheControl, serverRequest) => {
      const queryClient = new QueryClient();
      const { isLoggedIn } = serverRequest;
      const postId = Number(context.params.postId);

      if (!postId || Number.isNaN(postId)) {
        throw notFound();
      }

      try {
        if (isLoggedIn) {
          await queryClient.prefetchQuery(callvanQueries.postDetail(postId, isLoggedIn));
        }
      } catch (error) {
        console.error('[SSR] callvan post detail prefetch failed:', error);
      }

      return {
        dehydratedState: dehydrate(queryClient),
        postId,
      };
    }),
  );

export const Route = createFileRoute('/callvan/$postId/participants/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  return <CallvanParticipantsPage {...Route.useLoaderData()} />;
}
