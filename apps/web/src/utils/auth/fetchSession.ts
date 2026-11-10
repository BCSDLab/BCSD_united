import { getWebSession } from 'api/auth';

import { ANONYMOUS_SESSION, authenticatedSession, type Session, toUserType } from './session';
import { confirmSession, prepareSessionFetch, sessionCookie } from './sessionConfirmation';

// CSRF 쿠키가 없으면 세션이 없다고 보고 요청하지 않는다.
export default async function fetchSession(): Promise<Session> {
  const cookie = sessionCookie();
  prepareSessionFetch(cookie);
  if (!cookie) return confirmSession(cookie, ANONYMOUS_SESSION);

  const { authenticated, user_type: userType } = await getWebSession();
  const resolved = authenticated ? toUserType(userType) : null;

  return confirmSession(cookie, resolved ? authenticatedSession(resolved) : ANONYMOUS_SESSION);
}
