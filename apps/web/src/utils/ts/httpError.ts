import { isHttpError, isKoinError } from 'interfaces/APIError';

// KoinError 또는 HttpError에 담긴 HTTP 상태 코드를 꺼낸다.
export function getErrorStatus(error: unknown): number | undefined {
  if (isKoinError(error) || isHttpError(error)) return error.status;

  return undefined;
}

export function isUnauthorizedError(error: unknown) {
  return getErrorStatus(error) === 401;
}
