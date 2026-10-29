import { createError, defineEventHandler, deleteCookie, getCookie, getRequestURL, setHeader } from 'h3';
import { GOOGLE_MEET_KEY } from '~/services/google/googleMeet';
import { exchangeGoogleCode, GOOGLE_OAUTH_COOKIE, validateGoogleOAuthSession } from '~/services/google/oauth';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  setHeader(event, 'Referrer-Policy', 'no-referrer');
  const parameters = getRequestURL(event).searchParams;
  const state = parameters.get('state');
  const cookie = getCookie(event, GOOGLE_OAUTH_COOKIE);
  deleteCookie(event, GOOGLE_OAUTH_COOKIE, { path: '/auth' });
  const verifier = state ? await validateGoogleOAuthSession(state, cookie) : null;
  if (!verifier) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid or expired Google OAuth state; restart authorization',
    });
  }
  if (parameters.has('error')) {
    throw createError({ statusCode: 400, statusMessage: 'Google authorization was not granted' });
  }
  const code = parameters.get('code');
  if (!code) {
    throw createError({ statusCode: 400, statusMessage: 'Google OAuth authorization code missing' });
  }
  let token;
  try {
    token = await exchangeGoogleCode(code, verifier);
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'Google OAuth token exchange failed; restart authorization' });
  }
  if (!token.refresh_token || typeof token.refresh_token !== 'string') {
    throw createError({
      statusCode: 502,
      statusMessage: 'Google returned no refresh token; grant offline access again',
    });
  }
  await useStorage('kvStorage').set(GOOGLE_MEET_KEY, token.refresh_token);
  return 'OK';
});
