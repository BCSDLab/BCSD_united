import { ApiError } from '@api/errors';

export class IntegrationError extends ApiError {
  constructor(
    public readonly provider: string,
    public readonly providerCode: string,
    public readonly providerStatus: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
    public readonly timeout = false,
  ) {
    super(502, 'EXTERNAL_SERVICE_ERROR', `${provider} 요청에 실패했습니다. (${providerCode})`);
    this.name = 'IntegrationError';
  }
}

export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `${name} 설정이 필요합니다.`);
  return value;
}

/** 429 응답에 `Retry-After`가 없으면 60초를 기본 대기 시간으로 쓴다. 그 밖에는 헤더가 없거나 과거이면 `null`이다. */
export function retryAfter(response: Response, now = Date.now()): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  let milliseconds = NaN;
  if (raw && /^\d+$/.test(raw)) milliseconds = Number(raw) * 1000;
  else if (raw) milliseconds = Date.parse(raw) - now;
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  return response.status === 429 ? 60_000 : null;
}

export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function request(provider: string, url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new IntegrationError(provider, timeout ? 'TIMEOUT' : 'TRANSPORT_ERROR', null, true, null, timeout);
  }
}

export async function jsonResponse<T>(provider: string, response: Response): Promise<T> {
  if (!response.ok) {
    throw new IntegrationError(
      provider,
      `HTTP_${response.status}`,
      response.status,
      retryableStatus(response.status),
      retryAfter(response),
    );
  }
  try {
    return await response.json<T>();
  } catch {
    throw new IntegrationError(provider, 'INVALID_RESPONSE', response.status, true);
  }
}

export function base64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeBase64url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}

export async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}
