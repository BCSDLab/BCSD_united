import { createFileRoute } from '@tanstack/react-router';

import { fetchApiRequest, getApiBaseUrl } from 'utils/ssr/apiTarget';

const API_PREFIX = '/api';
const HOP_BY_HOP_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  'content-encoding': true,
  'content-length': true,
  'transfer-encoding': true,
};
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'x-csrf-token',
  'access_history_id',
  'user-agent',
];

function rewriteCookie(cookie: string): string {
  const path = /;\s*Path=([^;]*)/i.exec(cookie)?.[1] ?? '/';
  const browserPath = path === '/' ? '/' : `${API_PREFIX}${path}`;

  return `${cookie.replace(/;\s*Domain=[^;]*/gi, '').replace(/;\s*Path=[^;]*/gi, '')}; Path=${browserPath}`;
}

async function forward({ request }: { request: Request }): Promise<Response> {
  let base: string;
  try {
    base = getApiBaseUrl();
  } catch {
    return new Response('API origin is not configured for this environment.', { status: 503 });
  }
  const url = new URL(request.url);
  const suffix = `${url.pathname.slice(API_PREFIX.length)}${url.search}`;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (origin) headers.set('Origin', origin);
  if (referer) headers.set('Referer', referer);
  if (!origin && !referer && request.headers.get('sec-fetch-site') === 'same-origin') {
    headers.set('Origin', url.origin);
  }
  const upstreamRequest = new Request(base.replace(/\/$/, '') + suffix, {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(request.method !== 'GET' && request.method !== 'HEAD' ? { body: request.body } : {}),
  });
  const upstream = await fetchApiRequest(upstreamRequest);
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie' && !Object.hasOwn(HOP_BY_HOP_RESPONSE_HEADERS, name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('Set-Cookie', rewriteCookie(cookie));

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: forward,
      HEAD: forward,
      POST: forward,
      PUT: forward,
      PATCH: forward,
      DELETE: forward,
      OPTIONS: forward,
    },
  },
});
