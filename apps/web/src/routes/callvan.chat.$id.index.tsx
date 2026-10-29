import { Suspense, useEffect } from 'react';
import { createFileRoute, useNavigate, useSearch, useParams } from '@tanstack/react-router';

import CallvanChatRoom from 'components/Callvan/components/CallvanChatRoom';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';

export default function CallvanChatPage() {
  const routeNavigate = useNavigate();
  const routeQuery: Record<string, string | string[] | undefined> = {
    ...useSearch({ strict: false }),
    ...useParams({ strict: false }),
  };

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

  const postId = Number(routeQuery.id);

  if (!postId) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <CallvanChatRoom postId={postId} />
    </Suspense>
  );
}

export const Route = createFileRoute('/callvan/chat/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: CallvanChatPage,
});
