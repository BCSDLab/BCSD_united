import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';

import { runWithServerRequestHeaders } from 'utils/ssr/cookieForwarding';

const handleRequest = createStartHandler(defaultStreamHandler);
const entry = createServerEntry({
  async fetch(request) {
    const response = await runWithServerRequestHeaders(
      { cookie: request.headers.get('cookie') ?? '', origin: new URL(request.url).origin },
      () => handleRequest(request),
    );
    const headers = new Headers(response.headers);
    headers.set('Document-Policy', 'js-profiling');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
});

export default entry;
