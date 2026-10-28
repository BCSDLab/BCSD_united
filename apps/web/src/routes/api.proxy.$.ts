import { createFileRoute } from '@tanstack/react-router';

import { KOIN_BASE_URL } from 'static/url';

const PROXY_PREFIX = '/api/proxy';
const HOP_BY_HOP_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  'content-encoding': true,
  'content-length': true,
  'transfer-encoding': true,
};
const FORWARDED_REQUEST_HEADERS = ['cookie', 'content-type', 'accept', 'x-csrf-token', 'access_history_id', 'user-agent'];
const METHODS_WITH_BODY: Record<string, true> = { POST: true, PUT: true, PATCH: true };

function rewriteSetCookie(rawCookie: string): string {
  return `${rawCookie.replace(/;\s*Domain=[^;]*/gi, '').replace(/;\s*Path=[^;]*/gi, '')}; Path=/`;
}

async function proxy({ request }: { request: Request }): Promise<Response> {
  if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 });

  const url = new URL(request.url);
  const suffix = `${url.pathname.slice(PROXY_PREFIX.length)}${url.search}`;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Origin', KOIN_BASE_URL);
  headers.set('Referer', KOIN_BASE_URL);
  const upstream = await fetch(`${process.env.NEXT_PUBLIC_API_PATH}${suffix}`, {
    method: request.method,
    headers,
    ...(Object.hasOwn(METHODS_WITH_BODY, request.method) ? { body: await request.arrayBuffer() } : {}),
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie' && !Object.hasOwn(HOP_BY_HOP_RESPONSE_HEADERS, name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('Set-Cookie', rewriteSetCookie(cookie));
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const Route = createFileRoute('/api/proxy/$')({
  server: {
    handlers: { GET: proxy, HEAD: proxy, POST: proxy, PUT: proxy, PATCH: proxy, DELETE: proxy, OPTIONS: proxy },
  },
});
