export interface KoinError {
  type: 'KOIN_ERROR';
  status: number;
  code: number | string;
  message: string;
}

export type HttpErrorCode = 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED';

export class HttpError extends Error {
  readonly type = 'HTTP_ERROR';
  readonly status?: number;
  readonly data?: unknown;
  readonly code: HttpErrorCode;

  constructor(
    message: string,
    options: { status?: number; data?: unknown; code?: HttpErrorCode; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpError';
    this.status = options.status;
    this.data = options.data;
    this.code = options.code ?? 'HTTP_ERROR';
  }
}

export function isKoinError(error: unknown): error is KoinError {
  return typeof error === 'object' && error !== null && 'type' in error && error.type === 'KOIN_ERROR';
}

export function isHttpError(error: unknown): error is HttpError {
  return typeof error === 'object' && error !== null && 'type' in error && error.type === 'HTTP_ERROR';
}
