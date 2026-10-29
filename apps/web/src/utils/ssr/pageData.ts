import { getRequest, getResponseHeader, setResponseHeader } from '@tanstack/react-start/server';

import { runWithServerRequestHeaders } from 'utils/ssr/cookieForwarding';
import { getServerRequestContext, type ServerRequestContext } from 'utils/ssr/requestContext';

export const PUBLIC_SSR_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
export const STORE_PUBLIC_SSR_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=1800';
export const PRIVATE_SSR_CACHE_CONTROL = 'private, no-store';

export type PageSearch = Record<string, string | string[] | undefined>;
export interface PageInput {
  params: Record<string, string>;
  search: PageSearch;
}
export interface PageRequest extends PageInput {
  request: Request;
}
export interface PageCacheControl {
  enablePublicCache: (cacheControl?: string) => void;
}

export function validatePageInput(value: unknown): PageInput {
  if (!value || typeof value !== 'object' || !('params' in value) || !('search' in value)) {
    throw new TypeError('Invalid route input');
  }
  const { params, search } = value;
  if (
    !params ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    !search ||
    typeof search !== 'object' ||
    Array.isArray(search)
  ) {
    throw new TypeError('Invalid route input');
  }
  const validParams: Record<string, string> = {};
  const validSearch: PageSearch = {};
  for (const [key, entry] of Object.entries(params)) {
    if (typeof entry !== 'string') throw new TypeError('Invalid route parameter');
    Object.defineProperty(validParams, key, { value: entry, enumerable: true });
  }
  for (const [key, entry] of Object.entries(search)) {
    if (
      entry !== undefined &&
      typeof entry !== 'string' &&
      !(Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
    ) {
      throw new TypeError('Invalid route search');
    }
    Object.defineProperty(validSearch, key, { value: entry, enumerable: true });
  }

  return { params: validParams, search: validSearch };
}

/** 요청 쿠키와 서버 스냅샷은 클라이언트 입력이 아니라 현재 HTTP 요청에서만 얻는다. */
export async function loadPageData<Props extends object>(
  input: PageInput,
  load: (
    context: PageRequest,
    cacheControl: PageCacheControl,
    serverRequest: ServerRequestContext,
  ) => Props | Promise<Props>,
) {
  const request = getRequest();
  const cookie = request.headers.get('cookie') ?? '';
  const serverRequest = await getServerRequestContext(request);
  let policy = PRIVATE_SSR_CACHE_CONTROL;
  setResponseHeader('Cache-Control', policy);
  const props = await runWithServerRequestHeaders({ cookie, origin: new URL(request.url).origin }, () =>
    load(
      { ...input, request },
      {
        enablePublicCache: (cacheControl = PUBLIC_SSR_CACHE_CONTROL) => {
          // 세션 만료·갱신 중인 방문자도 쿠키가 있으면 공유 캐시에서 제외한다.
          if (!cookie && !serverRequest.isLoggedIn) policy = cacheControl;
        },
      },
      serverRequest,
    ),
  );
  setResponseHeader('Cache-Control', getResponseHeader('Set-Cookie') ? PRIVATE_SSR_CACHE_CONTROL : policy);

  return { ...props, serverRequest };
}
