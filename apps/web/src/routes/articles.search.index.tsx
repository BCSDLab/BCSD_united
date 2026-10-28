import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { useEffect } from 'react';


import ArticlesSearchPage from 'components/Articles/components/ArticlesSearchPage';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useMount from 'utils/hooks/state/useMount';

export default function ArticlesSearchRoutePage() {
  
  const routeNavigate = useNavigate();
  
  
  const isMobile = useMediaQuery();
  const mounted = useMount();

  useEffect(() => {
    if (mounted && !isMobile) {
      routeNavigate({ href: ROUTES.Articles(), replace: true });
    }
  }, [mounted, isMobile, routeNavigate]);

  if (mounted && !isMobile) {
    return null;
  }

  return <ArticlesSearchPage />;
}



export const Route = createFileRoute('/articles/search/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: ArticlesSearchRoutePage,
});
