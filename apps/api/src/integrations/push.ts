import type { Bindings } from '@api/runtime';
import { ApiError } from '@api/errors';
import { base64url, IntegrationError, jsonResponse, request, required, retryAfter, retryableStatus } from '@api/integrations/http';

export interface PushInput { token: string; title: string; body: string; data?: Record<string, string> }

export class FcmError extends IntegrationError {
  constructor(public readonly errorCode: string, public readonly messagingErrorCode: string, status: number, retryable: boolean, retryAfterMs: number | null) {
    super('FCM', messagingErrorCode || errorCode, status, retryable, retryAfterMs);
    this.name = 'FcmError';
  }
}

interface AccessToken { value: string; expires: number }

/**
 * OAuth 액세스 토큰은 isolate 단위로 캐시한다. 자격 증명 해시를 함께 저장해 서비스 계정이 바뀌면
 * 이전 토큰을 쓰지 않는다. 동시에 들어온 요청은 하나의 발급(`pendingToken`)을 공유한다.
 */
let cachedToken: { credentialId: string; token: AccessToken } | undefined;
let pendingToken: { credentialId: string; promise: Promise<AccessToken> } | undefined;

const TOKEN_EXPIRY_MARGIN_MS = 60_000;

async function importServiceAccountKey(pem: string): Promise<CryptoKey> {
  try {
    const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
    const bytes = Uint8Array.from(atob(raw), (character) => character.charCodeAt(0));
    return await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'FCM_PRIVATE_KEY는 유효한 PKCS8 RSA 비밀키여야 합니다.');
  }
}

async function issueAccessToken(email: string, pem: string): Promise<AccessToken> {
  const key = await importServiceAccountKey(pem);
  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(encoder.encode(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const unsigned = `${header}.${claims}`;
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))));
  const response = await request('Google OAuth', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
  });
  const result = await jsonResponse<{ access_token?: string; expires_in?: number }>('Google OAuth', response);
  if (!result.access_token || !Number.isFinite(result.expires_in) || Number(result.expires_in) <= 60) {
    throw new IntegrationError('Google OAuth', 'INVALID_RESPONSE', response.status, true);
  }
  return { value: result.access_token, expires: Date.now() + Number(result.expires_in) * 1000 };
}

async function accessToken(env: Bindings): Promise<string> {
  const email = required(env.FCM_CLIENT_EMAIL, 'FCM_CLIENT_EMAIL');
  const pem = required(env.FCM_PRIVATE_KEY, 'FCM_PRIVATE_KEY').replaceAll('\\n', '\n');
  const credentialId = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${email}\n${pem}`))));
  if (cachedToken?.credentialId === credentialId && cachedToken.token.expires > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken.token.value;
  }
  if (pendingToken?.credentialId === credentialId) return (await pendingToken.promise).value;
  const promise = issueAccessToken(email, pem).then((token) => {
    cachedToken = { credentialId, token };
    return token;
  });
  pendingToken = { credentialId, promise };
  try {
    return (await promise).value;
  } finally {
    if (pendingToken?.promise === promise) pendingToken = undefined;
  }
}

export function fcmMessage(input: PushInput): Record<string, unknown> {
  const data = input.data ?? {};
  const androidData: Record<string, string> = {
    ...data,
    title: input.title ?? '',
    content: input.body ?? '',
    imageUrl: data.imageUrl ?? '',
    type: data.type ?? '',
  };
  if (data.schemeUri !== undefined) androidData.url = `koin://${data.schemeUri}`;
  const aps = {
    alert: { title: input.title, body: input.body },
    sound: 'default',
    ...(data.path ? { category: data.path } : {}),
    'mutable-content': 1,
  };
  return {
    token: input.token,
    android: { priority: 'HIGH', data: androidData },
    apns: {
      payload: { ...data, aps },
      ...(data.imageUrl ? { fcm_options: { image: data.imageUrl } } : {}),
    },
  };
}

interface FcmErrorBody { error?: { status?: string; details?: { '@type'?: string; errorCode?: string }[] } }

export async function sendPush(env: Bindings, input: PushInput): Promise<void> {
  if (!input.token.trim()) throw new ApiError(400, 'INVALID_FCM_TOKEN', '푸시 알림 토큰이 필요합니다.');
  const project = required(env.FCM_PROJECT_ID, 'FCM_PROJECT_ID');
  const response = await request('FCM', `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: fcmMessage(input) }),
  });
  if (!response.ok) {
    if (response.status === 401) cachedToken = undefined;
    let result: FcmErrorBody = {};
    try {
      result = await response.json();
    } catch {
      // 응답 본문이 손상되어도 HTTP 상태로 재시도 여부를 판단한다.
    }
    const errorCode = result.error?.status ?? `HTTP_${response.status}`;
    const fcmDetail = result.error?.details?.find((item) => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError');
    throw new FcmError(errorCode, fcmDetail?.errorCode ?? '', response.status, retryableStatus(response.status), retryAfter(response));
  }
  const result = await jsonResponse<{ name?: string }>('FCM', response);
  if (!result.name) throw new IntegrationError('FCM', 'INVALID_RESPONSE', response.status, true);
}
