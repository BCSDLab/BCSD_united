import { WEB_AUTH_CSRF_COOKIE_KEY } from 'static/url';
import { ANONYMOUS_SESSION, SESSION_QUERY_KEY, type Session } from 'utils/auth/session';
import { clearAllChatCache } from 'utils/db/chatDB';
import { getCookie } from 'utils/ts/cookie';
import { queryClient } from 'utils/ts/queryClient';

let confirmedCookie: string | undefined;
let initialized = false;

export const sessionCookie = () => (typeof document === 'undefined' ? undefined : getCookie(WEB_AUTH_CSRF_COOKIE_KEY));

export function initializeSessionConfirmation(isLoggedIn: boolean) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  if (isLoggedIn) confirmedCookie = sessionCookie();
}

export function isConfirmedSession(cookie: string | undefined) {
  return !!cookie && cookie === confirmedCookie;
}

export function prepareSessionFetch(cookie: string | undefined) {
  const cached = queryClient.getQueryData<Session>(SESSION_QUERY_KEY);
  if ((confirmedCookie && confirmedCookie !== cookie) || (!cookie && cached?.status === 'authenticated')) {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] || query.queryKey[1] !== SESSION_QUERY_KEY[1],
    });
    queryClient.setQueryData(SESSION_QUERY_KEY, ANONYMOUS_SESSION);
    confirmedCookie = undefined;
    void clearAllChatCache();
  }
}

export function confirmSession(cookie: string | undefined, session: Session) {
  if (cookie !== sessionCookie()) throw new Error('Session cookie changed during request');
  if (
    session.status === 'anonymous' &&
    queryClient.getQueryData<Session>(SESSION_QUERY_KEY)?.status === 'authenticated'
  ) {
    void clearAllChatCache();
  }
  confirmedCookie = cookie;

  return session;
}
