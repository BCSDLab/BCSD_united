import { withSentry } from '@sentry/cloudflare';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';
import { getSentryOptions } from 'instrumentation-server';
import { KOIN_BASE_URL } from 'static/url';
import { runWithServerRequestHeaders } from 'utils/ssr/cookieForwarding';

const handleRequest = createStartHandler(defaultStreamHandler);
const entry = createServerEntry({
  async fetch(request) {
    const response = await runWithServerRequestHeaders(
      { cookie: request.headers.get('cookie') ?? '', origin: KOIN_BASE_URL },
      () => handleRequest(request),
    );
    const headers = new Headers(response.headers);
    headers.set('Document-Policy', 'js-profiling');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
});

export default withSentry(getSentryOptions, {
  fetch: (request) => entry.fetch(request),
});
