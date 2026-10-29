import { createServerFn } from '@tanstack/react-start';
import { getCookie, getRequest } from '@tanstack/react-start/server';

import { WEB_AUTH_CSRF_COOKIE_KEY } from 'static/url';
import { getServerRequestContext } from 'utils/ssr/requestContext';

export const getRootSnapshot = createServerFn({ method: 'GET' }).handler(async () => ({
  serverRequest: await getServerRequestContext(getRequest()),
  hasSession: Boolean(getCookie(WEB_AUTH_CSRF_COOKIE_KEY)),
}));
