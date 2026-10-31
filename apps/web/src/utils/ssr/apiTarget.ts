import axios, { AxiosError, AxiosHeaders, CanceledError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { env } from 'cloudflare:workers';

interface ApiEnvironment {
  KOIN_ENVIRONMENT?: string;
  KOIN_API_ORIGIN?: string;
  KOIN_API?: Fetcher;
}

// 웹은 KOIN_API_V2(Java) 운영·stage 서버를 사용한다
const MAIN_API_ORIGIN = 'https://api.koreatech.in';
const PREVIEW_API_ORIGIN = 'https://api.stage.koreatech.in';

function getApiEnvironment(): ApiEnvironment {
  const bindings: ApiEnvironment = env;
  let expectedOrigin: string | undefined;
  if (bindings.KOIN_ENVIRONMENT === 'main') expectedOrigin = MAIN_API_ORIGIN;
  if (bindings.KOIN_ENVIRONMENT === 'preview') expectedOrigin = PREVIEW_API_ORIGIN;

  if (!expectedOrigin || bindings.KOIN_API_ORIGIN !== expectedOrigin) {
    throw new Error('API origin does not match the Worker environment.');
  }

  return bindings;
}

export function getApiBaseUrl(): string {
  return getApiEnvironment().KOIN_API_ORIGIN!;
}

export function fetchApiRequest(request: Request): Promise<Response> {
  const bindings = getApiEnvironment();
  if (new URL(request.url).origin !== bindings.KOIN_API_ORIGIN) {
    throw new Error('API request does not match the Worker environment.');
  }

  // `KOIN_API`는 오프라인 검증 빌드에서만 붙는 로컬 API Worker다. 배포된 웹은 HTTP로 호출한다
  return bindings.KOIN_API ? bindings.KOIN_API.fetch(request) : fetch(request);
}

export const apiRequestAdapter: AxiosAdapter = async (config) => {
  const controller = new AbortController();
  const cancelToken = config.cancelToken;
  let request: Request | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const { promise: cancellation, reject: rejectCancellation } = Promise.withResolvers<never>();
  const cancel = (reason: unknown) => {
    rejectCancellation(reason);
    controller.abort();
  };
  const onAbort = () => {
    const error = new CanceledError(undefined, config, request);
    try {
      if (config.signal && 'reason' in config.signal && config.signal.reason !== undefined) {
        Object.assign(error, { reason: config.signal.reason });
      }
    } catch {
      // 사용자 정의 `signal.reason` getter가 실패해도 취소는 진행한다.
    }
    cancel(error);
  };

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(name, String(value));
    }
    if (config.data === undefined || config.data instanceof FormData) headers.delete('Content-Type');

    request = new Request(axios.getUri(config), {
      method: config.method?.toUpperCase(),
      headers,
      body: config.data,
      signal: controller.signal,
      credentials: config.withCredentials === false ? 'omit' : 'include',
    });
    cancelToken?.subscribe(cancel);
    config.signal?.addEventListener?.('abort', onAbort);
    if (config.signal?.aborted) onAbort();
    if (config.timeout) {
      timeout = setTimeout(() => {
        cancel(
          new AxiosError(
            config.timeoutErrorMessage || `timeout of ${config.timeout}ms exceeded`,
            config.transitional?.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED,
            config,
            request,
          ),
        );
      }, config.timeout);
    }

    const send = async (): Promise<AxiosResponse> => {
      if (controller.signal.aborted) return cancellation;
      const response = await fetchApiRequest(request!);
      let data: unknown;
      switch (config.responseType) {
        case 'arraybuffer':
          data = await response.arrayBuffer();
          break;
        case 'blob':
          data = await response.blob();
          break;
        case 'stream':
          data = response.body;
          break;
        default:
          data = await response.text();
      }
      const responseHeaders = new AxiosHeaders(Object.fromEntries(response.headers));
      const cookies = response.headers.getSetCookie();
      if (cookies.length) responseHeaders['set-cookie'] = cookies;
      const result: AxiosResponse = {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        config,
        request,
      };
      if (response.status && config.validateStatus && !config.validateStatus(response.status)) {
        throw new AxiosError(
          `Request failed with status code ${response.status}`,
          [AxiosError.ERR_BAD_REQUEST, AxiosError.ERR_BAD_RESPONSE][Math.floor(response.status / 100) - 4],
          config,
          request,
          result,
        );
      }

      return result;
    };

    return await Promise.race([send(), cancellation]);
  } catch (error) {
    if (axios.isAxiosError(error) || axios.isCancel(error)) throw error;
    const failure = new AxiosError(
      error instanceof Error ? error.message : String(error),
      AxiosError.ERR_NETWORK,
      config,
      request,
    );
    if (error instanceof Error) failure.cause = error;
    throw failure;
  } finally {
    clearTimeout(timeout);
    cancelToken?.unsubscribe(cancel);
    config.signal?.removeEventListener?.('abort', onAbort);
  }
};
