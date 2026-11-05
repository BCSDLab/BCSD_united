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
