// Java JwtProvider(jjwt 0.12)와 같은 키·검증 규칙. 키 = base64(secret UTF-8)의 ASCII 바이트,
// 알고리즘 = 키 길이로 jjwt가 고르는 HS256/384/512. 서명 외 exp·nbf·crit도 jjwt처럼 거부한다.

export class TokenError extends Error {}

const encoder = new TextEncoder();
const keys = new Map<string, Promise<{ key: CryptoKey; alg: string }>>();

function hmacKey(secret: string): Promise<{ key: CryptoKey; alg: string }> {
  let entry = keys.get(secret);
  if (!entry) {
    const bytes = encoder.encode(btoa(String.fromCharCode(...encoder.encode(secret))));
    const bits = bytes.length * 8;
    const hash = bits >= 512 ? 'SHA-512' : bits >= 384 ? 'SHA-384' : bits >= 256 ? 'SHA-256' : null;
    if (!hash) return Promise.reject(new Error('JWT secret is too short for HMAC-SHA'));
    entry = crypto.subtle
      .importKey('raw', bytes, { name: 'HMAC', hash }, false, ['verify'])
      .then((key) => ({ key, alg: `HS${hash.slice(4)}` }));
    keys.clear();
    keys.set(secret, entry);
  }
  return entry;
}

function decode(part: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(part) || part.length % 4 === 1) throw new TokenError('malformed');
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function json(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(part)));
  } catch {
    throw new TokenError('malformed');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TokenError('malformed');
  return value as Record<string, unknown>;
}

/** 서명·만료를 확인한 claims를 돌려준다. 실패는 모두 TokenError(Java AuthenticationException). */
export async function verifyKoinToken(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const { key, alg } = await hmacKey(secret);
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new TokenError('malformed');
  const header = json(parts[0]);
  if (header.alg !== alg || 'crit' in header || 'zip' in header) throw new TokenError('algorithm');
  const valid = await crypto.subtle.verify('HMAC', key, decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new TokenError('signature');
  const claims = json(parts[1]);
  for (const name of ['exp', 'nbf'] as const) {
    if (name in claims && (typeof claims[name] !== 'number' || !Number.isFinite(claims[name]))) {
      throw new TokenError('malformed');
    }
  }
  if (typeof claims.exp === 'number' && now > claims.exp * 1000) throw new TokenError('expired');
  if (typeof claims.nbf === 'number' && now < claims.nbf * 1000) throw new TokenError('premature');
  return claims;
}

// Integer.valueOf(String.valueOf(claims.get("id"))).
function userId(claims: Record<string, unknown>): number {
  const value = claims.id;
  const text =
    typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[+-]?\d+$/.test(text)) throw new TokenError('user');
  const id = Number(text);
  if (id < -2_147_483_648 || id > 2_147_483_647) throw new TokenError('user');
  return id;
}

/** 앱(Bearer) 토큰. web_session_id 키가 있으면(값과 무관) 쿠키 전용 토큰이므로 거부한다. */
export async function appTokenUserId(secret: string, token: string, now?: number): Promise<number> {
  const claims = await verifyKoinToken(secret, token, now);
  if ('web_session_id' in claims) throw new TokenError('web token');
  return userId(claims);
}

/** 웹 쿠키 access 토큰. 비어 있지 않은 web_session_id가 필요하다. */
export async function webTokenClaims(
  secret: string,
  token: string,
  now?: number,
): Promise<{ userId: number; sessionId: string }> {
  const claims = await verifyKoinToken(secret, token, now);
  const sessionId = claims.web_session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TokenError('session');
  return { userId: userId(claims), sessionId };
}
