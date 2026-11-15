import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';
import { env } from 'cloudflare:workers';

import { runWithServerRequestHeaders } from 'utils/ssr/cookieForwarding';

const handleRequest = createStartHandler(defaultStreamHandler);
const serverEnvironment: { readonly KOIN_ENVIRONMENT?: string } = env;
// stage.koreatech.in과 Preview URL은 운영 페이지와 내용이 겹치므로 검색 색인에서 뺀다.
// robots.txt로 막으면 크롤러가 이 헤더를 읽지 못해 이미 색인된 페이지가 남으므로 크롤링은 허용한다.
const isIndexable = serverEnvironment.KOIN_ENVIRONMENT === 'main';
// Java API의 Origin과 일치하도록 공개 사이트는 SSR 전에 HTTPS 기본 포트로 이동시킨다.
const PUBLIC_HOSTS: Record<string, true> = { 'koreatech.in': true, 'stage.koreatech.in': true };

const entry = createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);
    if (
      Object.hasOwn(PUBLIC_HOSTS, url.hostname) &&
      (url.protocol === 'http:' || (url.protocol === 'https:' && url.port !== ''))
    ) {
      url.protocol = 'https:';
      url.port = '';

      return Response.redirect(url, 308);
    }

    const response = await runWithServerRequestHeaders(
      { cookie: request.headers.get('cookie') ?? '', origin: url.origin },
      () => handleRequest(request),
    );
    const headers = new Headers(response.headers);
    headers.set('Document-Policy', 'js-profiling');
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store');
    if (!isIndexable) headers.set('X-Robots-Tag', 'noindex, nofollow');

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
});

export default entry;
