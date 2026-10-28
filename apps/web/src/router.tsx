import { captureException } from '@sentry/core';
import { addIntegration, tanstackRouterBrowserTracingIntegration } from '@sentry/react';
import { createRouter, type Router } from '@tanstack/react-router';
import { routeTree } from 'routeTree.gen';
import { parseSearch, stringifySearch } from 'utils/routing/search';


export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    trailingSlash: 'never',
    parseSearch,
    stringifySearch,
    defaultPreload: false,
    defaultOnCatch: (error) => captureException(error),
  });
  if (!router.isServer) addIntegration(tanstackRouterBrowserTracingIntegration(router));

  return router;
}
export type AppRouter = Router<typeof routeTree>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }

  interface StaticDataRouteOption {
    requireAuth?: boolean;
    title?: string | ((pathname: string) => string);
    hasPageSeo?: boolean;
  }
}
