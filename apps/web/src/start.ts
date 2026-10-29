import { captureError, traceOperation } from '@koin/telemetry/runtime';
import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

import { isProtectedPath } from 'static/routeAccess';
import ROUTES from 'static/routes';
import { WEB_AUTH_CSRF_COOKIE_KEY } from 'static/url';

const errorReportingMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    captureError(error);
    throw error;
  }
});

const functionTracingMiddleware = createMiddleware({ type: 'function' }).server(({ next, serverFnMeta }) =>
  traceOperation({ name: serverFnMeta.name, op: 'function.tanstackstart' }, async () => {
    try {
      return await next();
    } catch (error) {
      captureError(error);
      throw error;
    }
  }),
);

const routeAccessMiddleware = createMiddleware().server(({ request, next }) => {
  const url = new URL(request.url);
  if (isProtectedPath(url.pathname) && !getCookie(WEB_AUTH_CSRF_COOKIE_KEY)) {
    const loginUrl = new URL(ROUTES.Auth(), url);
    loginUrl.searchParams.set('redirect', url.pathname + url.search);

    return Response.redirect(loginUrl, 307);
  }

  return next();
});

const csrfMiddleware = createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === 'serverFn' });

export const startInstance = createStart(() => ({
  requestMiddleware: [errorReportingMiddleware, csrfMiddleware, routeAccessMiddleware],
  functionMiddleware: [functionTracingMiddleware],
}));
