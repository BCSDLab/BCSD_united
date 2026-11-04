import { env } from 'cloudflare:workers';

interface ApiEnvironment {
  KOIN_ENVIRONMENT?: string;
  KOIN_API_ORIGIN?: string;
  KOIN_API?: Fetcher;
}

const MAIN_API_ORIGIN = 'https://koin-api.bcsdlab.workers.dev';
const PREVIEW_API_ORIGIN = 'https://preview-koin-api.bcsdlab.workers.dev';

function getApiEnvironment(): ApiEnvironment {
  const bindings: ApiEnvironment = env;
  let expectedOrigin: string | undefined;
  if (bindings.KOIN_ENVIRONMENT === 'main') expectedOrigin = MAIN_API_ORIGIN;
  if (bindings.KOIN_ENVIRONMENT === 'preview') expectedOrigin = PREVIEW_API_ORIGIN;

  if (!expectedOrigin || bindings.KOIN_API_ORIGIN !== expectedOrigin) {
    throw new Error('API origin does not match the Worker environment.');
  }
  if (bindings.KOIN_ENVIRONMENT === 'main' && !bindings.KOIN_API) {
    throw new Error('Main API service binding is not configured.');
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

  return bindings.KOIN_ENVIRONMENT === 'preview' ? fetch(request) : bindings.KOIN_API!.fetch(request);
}
