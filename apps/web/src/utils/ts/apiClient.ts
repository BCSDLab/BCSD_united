import { traceOperation } from '@koin/telemetry/runtime';

import { WebRefresh, WebSession } from 'api/auth/APIDetail';
import { HttpError, isHttpError, type KoinError } from 'interfaces/APIError';
import { type APIRequest, type APIResult, HTTP_METHOD } from 'interfaces/APIRequest';
import type { APIResponse } from 'interfaces/APIResponse';
import { WEB_AUTH_CSRF_COOKIE_KEY } from 'static/url';
import { hasSessionCookie } from 'utils/auth/session';
import { markSessionAuthenticated, markSessionExpired } from 'utils/auth/sessionControl';
import { fetchApiRequest, getApiBaseUrl } from 'utils/ssr/apiTarget';
import { getServerRequestHeaders } from 'utils/ssr/cookieForwarding';
import qsStringify from 'utils/ts/qsStringfy';

import { getCookie } from './cookie';

const isBrowser = typeof window !== 'undefined';

function normalizeApiPath(path: string | undefined): string {
  if (!path) return 'unknown';

  return path
    .split('?')[0]
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id');
}

// 새 헤더 관심사가 생기면 createHeaders 본문을 늘리는 대신 이 파이프라인에 추가
type HeaderContributor = <R extends APIResponse>(request: APIRequest<R>, headers: Record<string, string>) => void;

const withSSRCookieForwarding: HeaderContributor = (request, headers) => {
  if (isBrowser || request.withCredentials === false) return;
  const serverRequestHeaders = getServerRequestHeaders();
  if (serverRequestHeaders?.cookie) headers.Cookie = serverRequestHeaders.cookie;
  if (serverRequestHeaders?.origin) headers.Origin = serverRequestHeaders.origin;
};

const withCsrfToken: HeaderContributor = (request, headers) => {
  if (request.method === HTTP_METHOD.GET || request.withCredentials === false) return;
  const csrfToken = getCookie(WEB_AUTH_CSRF_COOKIE_KEY);
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
};

// 본문이 있으면 메서드와 무관하게 JSON으로 보낸다(DELETE 본문 포함). 문자열 본문의 fetch 기본값은 text/plain이다.
const withJsonContentType: HeaderContributor = (request, headers) => {
  if (request.data !== undefined && !(request.data instanceof FormData) && !(request.data instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
  }
};

const withCustomHeaders: HeaderContributor = (request, headers) => {
  if (request.headers) {
    for (const [name, value] of Object.entries(request.headers)) headers[name] = String(value);
  }
};

// withCustomHeaders가 마지막에 와야 호출부가 위 기본값을 덮어쓸 수 있음
const HEADER_CONTRIBUTORS: HeaderContributor[] = [
  withSSRCookieForwarding,
  withCsrfToken,
  withJsonContentType,
  withCustomHeaders,
];

type Constructor<T> = new (...args: never[]) => T;

type ResponseType<T> = T extends APIRequest<infer U> ? U : never;

export default class APIClient {
  static shared = new APIClient();

  static request<U extends APIResponse>(request: APIRequest<U>): Promise<U> {
    return APIClient.shared.request(request);
  }

  static toCallable<T extends Constructor<APIRequest<APIResponse>>>(api: T) {
    return (...args: ConstructorParameters<T>) =>
      APIClient.request<ResponseType<InstanceType<T>>>(
        new api(...args) as unknown as APIRequest<ResponseType<InstanceType<T>>>,
      );
  }

  static of = APIClient.toCallable;

  get baseURL(): string {
    return getApiBaseUrl();
  }

  timeout: number = 20 * 1000;

  async request<U extends APIResponse>(request: APIRequest<U>): Promise<U> {
    const route = normalizeApiPath(request.path);
    let response: APIResult<U>;

    try {
      response = await this.sendRequest(request);
    } catch (error) {
      if (!isHttpError(error)) throw error;
      try {
        const retried = await this.errorMiddleware(error, request);
        if (retried) return this.parseResponse(request, retried, route, true);
      } catch {
        // 갱신이나 한 번의 재시도가 실패하면 원래 HTTP 오류를 유지한다.
      }

      throw this.createTracedKoinError(error, route);
    }

    return this.parseResponse(request, response, route);
  }

  private parseResponse<U extends APIResponse>(
    request: APIRequest<U>,
    response: APIResult<U>,
    route: string,
    retried = false,
  ): U {
    return traceOperation(
      {
        name: `${retried ? 'Parse retried' : 'Parse'} API response: ${route}`,
        op: 'koin.api.parse',
        onlyIfParent: true,
        attributes: {
          'api.route': route,
          ...(retried ? { 'api.retry': true } : { 'koin.response_shape': response.data == null ? 'null' : 'value' }),
          'http.response.status_code': response.status,
        },
      },
      () => (request.parse ? request.parse(response) : response.data),
    );
  }

  private resolveUrl<U extends APIResponse>(request: APIRequest<U>): URL {
    const { path } = request;
    const browserOrigin = isBrowser ? window.location.origin : undefined;
    const base = request.baseURL ?? this.baseURL;
    const url =
      /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')
        ? new URL(path, browserOrigin ?? (base || this.baseURL))
        : new URL(`${base.replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`, browserOrigin);
    if (request.params) {
      const query = qsStringify(request.params);
      if (query) url.search += `${url.search ? '&' : '?'}${query}`;
    }

    return url;
  }

  private body<U extends APIResponse>(request: APIRequest<U>): BodyInit | undefined {
    if (request.data === undefined) return undefined;
    if (request.data instanceof FormData || request.data instanceof Blob) return request.data;

    return request.convertBody ? request.convertBody(request.data) : JSON.stringify(request.data);
  }

  private async sendRequest<U extends APIResponse>(request: APIRequest<U>): Promise<APIResult<U>> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // 브라우저 요청 경로에서도 실행되므로 Promise.withResolvers(iOS 17.4+/Chrome 119+)에 의존하지 않는다.
    let reject!: (reason: HttpError) => void;
    const cancellation = new Promise<never>((_, rejectCancellation) => {
      reject = rejectCancellation;
    });
    const cancel = () => {
      reject(new HttpError('Request aborted', { code: 'ABORTED', cause: request.signal?.reason }));
      controller.abort();
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    if (request.signal?.aborted) cancel();
    if (this.timeout > 0) {
      timeout = setTimeout(() => {
        // 본문 읽기의 AbortError가 시간 초과를 덮지 않도록 먼저 실패시킨다.
        reject(new HttpError(`timeout of ${this.timeout}ms exceeded`, { code: 'TIMEOUT' }));
        controller.abort();
      }, this.timeout);
    }

    try {
      const send = async (): Promise<APIResult<U>> => {
        if (controller.signal.aborted) return cancellation;
        const response = await fetchApiRequest(
          new Request(this.resolveUrl(request), {
            method: request.method,
            headers: this.createHeaders(request),
            body: this.body(request),
            signal: controller.signal,
            credentials: request.withCredentials === false ? 'omit' : 'include',
            // Java SSR 요청의 쿠키가 리다이렉트 대상에 전달되지 않도록 기존 보호를 유지한다.
            redirect: isBrowser ? 'follow' : 'manual',
          }),
        );
        const text = await response.text();
        let data: unknown = text;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            // JSON이 아닌 응답은 원문 문자열로 유지한다.
          }
        }
        if (!response.ok) {
          throw new HttpError(`Request failed with status code ${response.status}`, {
            status: response.status,
            data,
          });
        }

        return { data: data as U, status: response.status, statusText: response.statusText, headers: response.headers };
      };

      return await Promise.race([send(), cancellation]);
    } catch (error) {
      if (isHttpError(error)) throw error;
      throw new HttpError(error instanceof Error ? error.message : String(error), {
        code: request.signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', cancel);
    }
  }

  static webRefresh = this.of(WebRefresh);

  static webSession = this.of(WebSession);

  private refreshPromise: Promise<boolean> | null = null;

  // 실패해도 던지지 않고 성공 여부만 돌려준다.
  private refreshAccessToken(): Promise<boolean> {
    this.refreshPromise ??= this.refreshOnce().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<boolean> {
    try {
      // refresh는 X-CSRF-Token이 필수라, CSRF 쿠키가 없으면 세션 조회로 복구한다.
      if (!hasSessionCookie() && !(await APIClient.webSession()).authenticated) return false;
      const result = await APIClient.webRefresh();
      markSessionAuthenticated(result.user_type);

      return true;
    } catch {
      return false;
    }
  }

  private retryRequest<U extends APIResponse>(request: APIRequest<U>): Promise<APIResult<U>> {
    const route = normalizeApiPath(request.path);

    return traceOperation(
      {
        name: `Retry API request: ${route}`,
        op: 'koin.api.retry',
        onlyIfParent: true,
        attributes: { 'api.route': route },
      },
      () => this.sendRequest(request),
    );
  }

  private async handleUnauthorized<U extends APIResponse>(request: APIRequest<U>): Promise<APIResult<U> | null> {
    const refreshed = await traceOperation(
      {
        name: 'Refresh API access token',
        op: 'koin.api.auth_refresh',
        onlyIfParent: true,
        attributes: { 'api.route': normalizeApiPath(request.path) },
      },
      () => this.refreshAccessToken(),
    );

    if (!refreshed) {
      markSessionExpired(request);

      return null;
    }

    try {
      return await this.retryRequest(request);
    } catch (retryError) {
      // 갱신 직후에도 401이면 세션이 끝난 것이다. 5xx 등은 세션과 무관하다.
      if (isHttpError(retryError) && retryError.status === 401) markSessionExpired(request);

      return null;
    }
  }

  // SSR은 refresh를 할 수 없어 그대로 401을 던지는 게 정상 흐름이지만, Cookie 컨텍스트 자체가
  // 없어서 401이 난 경우(loadPageData로 감싸지 않은 loader 등)는 원인을 바로 알 수 있어야 한다.
  private handleServerSideError(error: HttpError, route: string): null {
    if (error.status === 401 && !getServerRequestHeaders()?.cookie) {
      console.warn(
        `[apiClient] SSR 요청 헤더 컨텍스트 없이 401 발생: ${route}. ` +
          '라우트 loader가 loadPageData로 감싸져 있는지 확인하세요.',
      );
    }

    return null;
  }

  private async errorMiddleware<U extends APIResponse>(
    error: HttpError,
    request: APIRequest<U>,
  ): Promise<APIResult<U> | null> {
    if (!isBrowser) return this.handleServerSideError(error, normalizeApiPath(request.path));
    if (request.skipAuthRefresh || error.status !== 401) return null;

    return this.handleUnauthorized(request);
  }

  private createKoinError(error: HttpError): HttpError | (Error & KoinError) {
    const data = error.data;
    if (
      error.status !== undefined &&
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      (typeof data.code === 'number' || typeof data.code === 'string') &&
      'message' in data &&
      typeof data.message === 'string'
    ) {
      return Object.assign(new Error(data.message), {
        type: 'KOIN_ERROR' as const,
        status: error.status,
        code: data.code,
      });
    }

    return error;
  }

  private createTracedKoinError(error: HttpError, route: string): HttpError | (Error & KoinError) {
    return traceOperation(
      {
        name: `Convert API error: ${route}`,
        op: 'koin.api.error_conversion',
        onlyIfParent: true,
        attributes: {
          'api.route': route,
          'http.response.status_code': error.status ?? 'network',
          'koin.response_shape': error.data == null ? 'null' : 'value',
        },
      },
      () => this.createKoinError(error),
    );
  }

  private createHeaders<U extends APIResponse>(request: APIRequest<U>): Headers {
    const values: Record<string, string> = {};
    HEADER_CONTRIBUTORS.forEach((contribute) => contribute(request, values));

    return new Headers(values);
  }
}
