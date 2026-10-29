import { createError, defineEventHandler, getHeader, sendRedirect, setCookie, setHeader } from 'h3';
import {
  createGoogleOAuthSession,
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_OAUTH_MAX_AGE,
  GOOGLE_OAUTH_SCOPES,
  googleOAuthCredentials,
  googleRedirectUri,
  isGoogleAdmin,
} from '~/services/google/oauth';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  setHeader(event, 'Referrer-Policy', 'no-referrer');
  let authorized: boolean;
  let clientId: string;
  let redirectUri: string;
  try {
    authorized = await isGoogleAdmin(getHeader(event, 'authorization'));
    ({ clientId } = googleOAuthCredentials());
    redirectUri = googleRedirectUri();
  } catch (error) {
    throw createError({
      statusCode: 503,
      statusMessage: error instanceof Error ? error.message : 'Google OAuth is not configured',
    });
  }
  if (!authorized) {
    setHeader(event, 'WWW-Authenticate', 'Basic realm="B-BOT Google authorization", charset="UTF-8"');
    throw createError({ statusCode: 401, statusMessage: 'Google OAuth administrator authorization required' });
  }
  const session = await createGoogleOAuthSession();
  setCookie(event, GOOGLE_OAUTH_COOKIE, session.cookie, {
    httpOnly: true,
    secure: new URL(redirectUri).protocol === 'https:',
    sameSite: 'lax',
    path: '/auth',
    maxAge: GOOGLE_OAUTH_MAX_AGE,
  });
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    prompt: 'consent',
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    state: session.state,
    code_challenge: session.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return sendRedirect(event, authorizationUrl.toString(), 302);
});
