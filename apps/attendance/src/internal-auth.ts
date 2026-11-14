export interface InternalAuthEnv {
  INTERNAL_AUTH_CLIENT_ID?: string;
  INTERNAL_AUTH_CLIENT_SECRET?: string;
}

export interface VerifiedInternalSession {
  memberId: string;
  name: string;
  expiresAt: number;
}

export type InternalSessionResult = { ok: true; session: VerifiedInternalSession } | { ok: false; response: Response };

export interface InternalAuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface InternalAuth {
  verify(request: Request): Promise<InternalSessionResult>;
  login(request: Request): Promise<Response>;
  me(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

export const INTERNAL_SESSION_COOKIE = '__Host-attendance-session';
const LOGIN_URL = 'https://bcsd-attendance-auth.koreatech.in/v1/auth/attendance-login';
const SESSION_URL = 'https://bcsd-attendance-auth.koreatech.in/v1/members/attendance-session';
const DEADLINE_MS = 5_000;
const SESSION_MS = 900_000;
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 8_192;
const MAX_TOKEN_LENGTH = 3_500;
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validToken(value: unknown): value is string {
  // 문법만 제한하며 서명·회원 자격·비밀번호 버전은 Internal에서 매 요청 검증한다.
  return (
    typeof value === 'string' &&
    value.length <= MAX_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

function configured(env: InternalAuthEnv): boolean {
  return [env.INTERNAL_AUTH_CLIENT_ID, env.INTERNAL_AUTH_CLIENT_SECRET].every(
    (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value),
  );
}

function clearCookie(): string {
  return `${INTERNAL_SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

function reply(body: unknown, status = 200, cookie?: string, allow?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (cookie) headers.set('set-cookie', cookie);
  if (allow) headers.set('allow', allow);
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(status: number, clear = false, allow?: string): Response {
  const error =
    status === 401
      ? 'authentication_required'
      : status === 503
        ? 'authentication_unavailable'
        : status === 403
          ? 'same_origin_required'
          : status === 405
            ? 'method_not_allowed'
            : 'invalid_request';
  return reply({ error }, status, clear ? clearCookie() : undefined, allow);
}

function cookieToken(request: Request): string | null | false {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  if (raw.length > 8_192 || raw.includes(',') || hasControlCharacters(raw)) return false;
  let token: string | null = null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== INTERNAL_SESSION_COOKIE) continue;
    if (token !== null || separator < 0) return false;
    const value = part.slice(separator + 1);
    if (!validToken(value)) return false;
    token = value;
  }
  return token;
}

function discard(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => {});
}

// 타이머는 본문의 마지막 바이트까지 유효하며 연결 종료 시 상류와 본문 리더를 중단한다.
async function bounded<T>(task: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => {
    controller.abort();
    reject(new Error());
  };
  const timer = setTimeout(abort, DEADLINE_MS);
  parent?.addEventListener('abort', abort, { once: true });
  try {
    if (parent?.aborted) abort();
    return await Promise.race([promise, task(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.abort();
  }
}

async function readJson(message: Request | Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!JSON_TYPE.test(message.headers.get('content-type') ?? '')) throw new Error();
  const encoding = message.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new Error();
  const length = message.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error();
  if (!message.body || signal.aborted) throw new Error();
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = '';
  let complete = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const result: unknown = JSON.parse(text);
    complete = true;
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

type UpstreamResult = { status: 200; value: unknown } | { status: 401 | 503 };

async function upstream(
  env: InternalAuthEnv,
  transport: typeof fetch,
  target: typeof LOGIN_URL | typeof SESSION_URL,
  signal: AbortSignal,
  credentials: { studentNumber: string; password: string } | { token: string },
): Promise<UpstreamResult> {
  if (signal.aborted) return { status: 503 };
  const headers = new Headers({
    accept: 'application/json',
    'CF-Access-Client-Id': env.INTERNAL_AUTH_CLIENT_ID!,
    'CF-Access-Client-Secret': env.INTERNAL_AUTH_CLIENT_SECRET!,
  });
  let body: string | undefined;
  if ('password' in credentials) {
    headers.set('content-type', 'application/json; charset=utf-8');
    body = JSON.stringify(credentials);
  } else {
    headers.set('authorization', `Bearer ${credentials.token}`);
  }
  const response = await transport(target, {
    method: target === LOGIN_URL ? 'POST' : 'GET',
    headers,
    body,
    redirect: 'manual',
    cache: 'no-store',
    signal,
  });
  if (signal.aborted || response.redirected || (response.url && response.url !== target)) {
    discard(response.body);
    return { status: 503 };
  }
  if (response.status !== 200) {
    discard(response.body);
    return { status: response.status === 401 ? 401 : 503 };
  }
  try {
    return { status: 200, value: await readJson(response, MAX_RESPONSE_BYTES, signal) };
  } catch {
    discard(response.body);
    return { status: 503 };
  }
}

function session(value: unknown, now: number): VerifiedInternalSession | null {
  if (!object(value) || !keys(value, ['memberId', 'name', 'expiresAt'])) return null;
  if (typeof value.memberId !== 'string' || !/^[1-9]\d{0,18}$/.test(value.memberId)) return null;
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 200 ||
    hasControlCharacters(value.name)
  )
    return null;
  if (
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + SESSION_MS
  )
    return null;
  return { memberId: value.memberId, name: value.name, expiresAt: value.expiresAt };
}

function mutationGuard(request: Request): Response | null {
  if (request.method !== 'POST') return failure(405, false, 'POST');
  const url = new URL(request.url);
  const site = request.headers.get('sec-fetch-site');
  if (
    url.protocol !== 'https:' ||
    request.headers.get('origin') !== url.origin ||
    (site !== null && site !== 'same-origin')
  )
    return failure(403);
  if (url.search || url.hash || !JSON_TYPE.test(request.headers.get('content-type') ?? '')) return failure(400);
  return null;
}

/** 반드시 CF_ACCESS_AUD의 플랫폼 ctx 게이트 뒤에서 호출하고 저장소·서비스 조회보다 앞에 둔다. */
export function createInternalAuth(env: InternalAuthEnv, options: InternalAuthOptions = {}): InternalAuth {
  const transport = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  async function verify(request: Request): Promise<InternalSessionResult> {
    if (!configured(env)) return { ok: false, response: failure(503) };
    const token = cookieToken(request);
    if (!token) return { ok: false, response: failure(401, token === false) };
    try {
      const result = await bounded(
        (signal) => upstream(env, transport, SESSION_URL, signal, { token }),
        request.signal,
      );
      if (result.status !== 200) return { ok: false, response: failure(result.status, result.status === 401) };
      const verified = session(result.value, now());
      if (!verified) return { ok: false, response: failure(503) };
      return { ok: true, session: verified };
    } catch {
      return { ok: false, response: failure(503) };
    }
  }

  return {
    verify,
    async login(request: Request): Promise<Response> {
      const rejected = mutationGuard(request);
      if (rejected) return rejected;
      if (!configured(env)) return failure(503);
      if (cookieToken(request) === false) return failure(401, true);
      let credentials: { studentNumber: string; password: string };
      try {
        const value = await bounded((signal) => readJson(request, MAX_REQUEST_BYTES, signal), request.signal);
        if (
          !object(value) ||
          !keys(value, ['studentNumber', 'password']) ||
          typeof value.studentNumber !== 'string' ||
          !/^\d{8,10}$/.test(value.studentNumber) ||
          typeof value.password !== 'string' ||
          !value.password.trim()
        )
          return failure(400);
        credentials = { studentNumber: value.studentNumber, password: value.password };
      } catch {
        return failure(400);
      }
      const startedAt = now();
      try {
        return await bounded(async (signal) => {
          const login = await upstream(env, transport, LOGIN_URL, signal, credentials);
          if (login.status !== 200) return failure(login.status, login.status === 401);
          const value = login.value;
          if (
            !object(value) ||
            !keys(value, ['accessToken', 'tokenType', 'expiresIn']) ||
            !validToken(value.accessToken) ||
            value.tokenType !== 'Bearer' ||
            value.expiresIn !== 900
          )
            return failure(503);
          const result = await upstream(env, transport, SESSION_URL, signal, { token: value.accessToken });
          if (result.status !== 200) return failure(result.status, result.status === 401);
          const verified = session(result.value, now());
          if (!verified) return failure(503);
          verified.expiresAt = Math.min(verified.expiresAt, startedAt + SESSION_MS);
          const seconds = Math.floor((verified.expiresAt - now()) / 1_000);
          if (seconds <= 0 || signal.aborted) return failure(401, true);
          return reply(
            { authenticated: true, ...verified, servedAt: now() },
            200,
            `${INTERNAL_SESSION_COOKIE}=${value.accessToken}; ${COOKIE_ATTRIBUTES}; Max-Age=${seconds}`,
          );
        }, request.signal);
      } catch {
        return failure(503);
      }
    },
    async me(request: Request): Promise<Response> {
      if (request.method !== 'GET') return failure(405, false, 'GET');
      const result = await verify(request);
      return result.ok ? reply({ authenticated: true, ...result.session, servedAt: now() }) : result.response;
    },
    async logout(request: Request): Promise<Response> {
      const rejected = mutationGuard(request);
      if (rejected) return rejected;
      try {
        const value = await bounded((signal) => readJson(request, MAX_REQUEST_BYTES, signal), request.signal);
        if (!object(value) || Object.keys(value).length !== 0) return failure(400);
      } catch {
        return failure(400);
      }
      if (cookieToken(request) === false) return failure(401, true);
      // 이 앱 쿠키만 지우며 Internal 로그아웃·출결 쓰기는 호출하지 않는다.
      return reply({ authenticated: false, servedAt: now() }, 200, clearCookie());
    },
  };
}
