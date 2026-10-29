const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/drive.readonly',
  'email',
  'profile',
];

export const GOOGLE_OAUTH_COOKIE = 'bbot-google-oauth';
export const GOOGLE_OAUTH_MAX_AGE = 600;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Google OAuth configuration missing: ${name}`);
  return value;
}

export function googleOAuthCredentials() {
  return {
    clientId: requiredEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
  };
}

export function googleRedirectUri(): string {
  const value = requiredEnv('GOOGLE_REDIRECT_URI');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GOOGLE_REDIRECT_URI must be an absolute Google OAuth callback URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    throw new Error('GOOGLE_REDIRECT_URI must use HTTPS (HTTP is allowed only for localhost)');
  }
  return url.toString();
}

export function googleAuthSecret(): string {
  return requiredEnv('GOOGLE_AUTH_SECRET');
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function requestToken(parameters: URLSearchParams): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = googleOAuthCredentials();
  parameters.set('client_id', clientId);
  parameters.set('client_secret', clientSecret);
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: parameters,
    });
  } catch {
    throw new Error('Google OAuth token endpoint could not be reached');
  }
  const data = (await response.json().catch(() => null)) as (GoogleTokenResponse & { error?: string }) | null;
  if (!response.ok) {
    const reason = data?.error === 'invalid_grant' ? '; authorize the bot again at /auth/google' : '';
    throw new Error(`Google OAuth token exchange failed (HTTP ${response.status})${reason}`);
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Google OAuth token endpoint returned no access token');
  }
  return data;
}

export async function googleAccessToken(refreshToken: string | null | undefined): Promise<string> {
  if (!refreshToken) throw new Error('Google refresh token missing; authorize the bot at /auth/google');
  const token = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  return token.access_token;
}

export async function exchangeGoogleCode(code: string, verifier: string): Promise<GoogleTokenResponse> {
  return requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: googleRedirectUri(),
      code_verifier: verifier,
    }),
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function stateKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(googleAuthSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createGoogleOAuthSession() {
  const nonce = randomToken();
  const verifier = randomToken();
  const expires = Math.floor(Date.now() / 1000) + GOOGLE_OAUTH_MAX_AGE;
  const payload = `${nonce}.${expires}.${verifier}`;
  const signature = base64url(
    new Uint8Array(await crypto.subtle.sign('HMAC', await stateKey(), new TextEncoder().encode(payload))),
  );
  const state = `${nonce}.${expires}.${signature}`;
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  return { state, cookie: `${state}.${verifier}`, challenge };
}

export async function validateGoogleOAuthSession(state: string, cookie: string | undefined): Promise<string | null> {
  if (!cookie || cookie.length > 256 || state.length > 200) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4) return null;
  const [nonce, expires, signature, verifier] = parts;
  if (
    state !== `${nonce}.${expires}.${signature}` ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(verifier) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return null;
  const expiry = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + GOOGLE_OAUTH_MAX_AGE) return null;
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    'HMAC',
    await stateKey(),
    bytes,
    new TextEncoder().encode(`${nonce}.${expires}.${verifier}`),
  );
  return valid ? verifier : null;
}

export async function isGoogleAdmin(authorization: string | undefined): Promise<boolean> {
  const secret = googleAuthSecret();
  if (!authorization || !/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization)) return false;
  let credentials: string;
  try {
    credentials = new TextDecoder().decode(Uint8Array.from(atob(authorization.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const separator = credentials.indexOf(':');
  if (separator < 0 || credentials.slice(0, separator) !== 'admin') return false;
  const encoder = new TextEncoder();
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
  const actual = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(credentials.slice(separator + 1))),
  );
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  return difference === 0;
}
