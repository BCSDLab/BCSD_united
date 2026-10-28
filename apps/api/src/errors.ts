export interface FieldError {
  field: string;
  message: string;
  constraint?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(error: ApiError): Response {
  return Response.json({
    code: error.code,
    message: error.message,
    errorTraceId: crypto.randomUUID(),
    ...(error.fieldErrors.length ? { fieldErrors: error.fieldErrors } : {}),
  }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
}
