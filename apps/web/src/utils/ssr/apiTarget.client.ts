export function fetchApiRequest(request: Request): Promise<Response> {
  return fetch(request);
}

export function getApiBaseUrl(): string {
  return '/api';
}
