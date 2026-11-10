import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';
import { env } from 'cloudflare:workers';

import { runWithServerRequestHeaders } from 'utils/ssr/cookieForwarding';

const handleRequest = createStartHandler(defaultStreamHandler);
const serverEnvironment: { readonly KOIN_ENVIRONMENT?: string } = env;
// stage.koreatech.in과 Preview URL은 운영 페이지와 내용이 겹치므로 검색 색인에서 뺀다.
// robots.txt로 막으면 크롤러가 이 헤더를 읽지 못해 이미 색인된 페이지가 남으므로 크롤링은 허용한다.
const isIndexable = serverEnvironment.KOIN_ENVIRONMENT === 'main';
const entry = createServerEntry({
  async fetch(request) {
    const response = await runWithServerRequestHeaders(
      { cookie: request.headers.get('cookie') ?? '', origin: new URL(request.url).origin },
      () => handleRequest(request),
    );
    const headers = new Headers(response.headers);
    headers.set('Document-Policy', 'js-profiling');
    // 문서의 SSR 시각은 브라우저 시계의 기준이므로 공유 캐시나 브라우저 캐시에 저장하지 않는다.
    if (headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) {
      headers.set('Cache-Control', 'private, no-store');
    } else if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'private, no-store');
    }
    if (!isIndexable) headers.set('X-Robots-Tag', 'noindex, nofollow');

    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
});

export default entry;
