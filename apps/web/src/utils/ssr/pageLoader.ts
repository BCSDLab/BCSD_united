import type { DehydratedState, QueryClient } from '@tanstack/react-query';

import { WebSession } from 'api/auth/APIDetail';
import { authQueries, SESSION_STALE_TIME } from 'api/auth/queries';
import { isHttpError } from 'interfaces/APIError';
import { ANONYMOUS_SESSION, SESSION_QUERY_KEY, type Session } from 'utils/auth/session';
import { isConfirmedSession, prepareSessionFetch, sessionCookie } from 'utils/auth/sessionConfirmation';
import type { ServerRequestContext } from 'utils/ssr/requestContext';
import { getFreshServerNow, initializeServerClock } from 'utils/ssr/serverClock';
import APIClient from 'utils/ts/apiClient';
import { getCookie } from 'utils/ts/cookie';
import { queryClient } from 'utils/ts/queryClient';

// 서버 전용 모듈(@tanstack/react-start/server)을 가져오지 않는다. 라우트 loader가 브라우저에서도 이 모듈을 실행한다.

/** load가 넘기는 상점 화면 공유 캐시 정책. SSR 응답에만 적용되고 브라우저 이동에서는 무시된다. */
export const STORE_PUBLIC_SSR_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=1800';

export type PageSearch = Record<string, string | string[] | undefined>;
export interface PageInput {
  params: Record<string, string>;
  search: PageSearch;
}
export interface PageCacheControl {
  enablePublicCache: (cacheControl?: string) => void;
}
export interface PageLoadContext extends PageInput {
  /** 미리 받을 쿼리를 채울 QueryClient. SSR은 요청마다 새로 만들고, 브라우저 이동은 앱 QueryClient를 그대로 쓴다. */
  queryClient: QueryClient;
  /** SSR은 요청 Cookie 헤더, 브라우저 이동은 document.cookie에서 읽는다. */
  getCookie: (name: string) => string | undefined;
}
export type PageLoad<Props extends object> = (
  context: PageLoadContext,
  cacheControl: PageCacheControl,
  serverRequest: ServerRequestContext,
) => Props | Promise<Props>;
/** SSR은 미리 받은 쿼리를 dehydratedState로 넘긴다. 브라우저 이동은 앱 QueryClient에 바로 채우므로 넘기지 않는다. */
export type PageData<Props extends object> = Props & {
  serverRequest: ServerRequestContext;
  dehydratedState?: DehydratedState;
};
export interface RootSnapshot {
  serverRequest: ServerRequestContext;
  hasSession: boolean;
}

const CLIENT_CACHE_CONTROL: PageCacheControl = { enablePublicCache: () => {} };
const clockClient = new APIClient();
clockClient.timeout = 2500;

/** load의 인자 타입을 정해 준다. 라우트는 load를 모듈 최상위에 두고 서버 함수와 createPageLoader에 같이 넘긴다. */
export const definePageLoad = <Props extends object>(load: PageLoad<Props>) => load;

/**
 * 라우트 loader. SSR은 서버 함수로 요청 쿠키·캐시 정책과 함께 실행한다.
 * 하이드레이션 이후 화면 이동은 같은 load를 브라우저에서 실행해 서버 함수를 거치지 않고 API를 직접 부른다.
 */
export function createPageLoader<Props extends object>(
  serverFn: (options: { data: PageInput }) => Promise<PageData<NoInfer<Props>>>,
  load: PageLoad<Props>,
) {
  return async (input: PageInput, context: { serverRequest: ServerRequestContext }): Promise<PageData<Props>> => {
    if (typeof window === 'undefined') return serverFn({ data: input });

    // load가 serverRequest를 고쳐 쓸 수 있으므로 루트 컨텍스트와 분리한다
    const serverRequest = { ...context.serverRequest };
    const props = await load({ ...input, queryClient, getCookie }, CLIENT_CACHE_CONTROL, serverRequest);

    return { ...props, serverRequest };
  };
}

/**
 * 기기는 SSR 값, 인증은 CSRF에 결부된 세션을 사용한다.
 * 공유 캐시 문서는 새 Date 표본이 없으면 이번 이동에만 SSR 시각 기준 오프셋을 사용한다.
 */
export async function getClientRootSnapshot(ssrServerRequest: ServerRequestContext): Promise<RootSnapshot> {
  initializeServerClock(ssrServerRequest.now, ssrServerRequest.mayBeSharedCached);
  const cookie = sessionCookie();
  prepareSessionFetch(cookie);
  const state = queryClient.getQueryState(SESSION_QUERY_KEY);
  let session: Session = ANONYMOUS_SESSION;
  let sessionFailedWithoutResponse = false;
  if (cookie) {
    if (
      isConfirmedSession(cookie) &&
      state?.data &&
      !state.isInvalidated &&
      Date.now() - state.dataUpdatedAt < SESSION_STALE_TIME
    ) {
      session = state.data as Session;
    } else {
      try {
        session = await queryClient.fetchQuery({ ...authQueries.session(), staleTime: 0, retry: false });
        if (!isConfirmedSession(sessionCookie())) session = ANONYMOUS_SESSION;
      } catch (error) {
        const cached = queryClient.getQueryData<Session>(SESSION_QUERY_KEY);
        session = isConfirmedSession(cookie) && cached ? cached : ANONYMOUS_SESSION;
        sessionFailedWithoutResponse = isHttpError(error) && error.status === undefined;
      }
    }
  }
  // 시계 표본 조회의 401이 인증 갱신을 재귀적으로 시작하지 않도록 한다.
  const now = await getFreshServerNow(
    () => clockClient.request(Object.assign(new WebSession(), { skipAuthRefresh: true })),
    sessionFailedWithoutResponse,
  );
  const currentCookie = sessionCookie();
  if (currentCookie !== cookie) {
    prepareSessionFetch(currentCookie);
    session = ANONYMOUS_SESSION;
  }
  const userType = session.status === 'authenticated' ? session.userType : null;

  return {
    serverRequest: {
      device: ssrServerRequest.device,
      isLoggedIn: userType !== null,
      userType,
      now,
      mayBeSharedCached: false,
    },
    hasSession: !!currentCookie,
  };
}
