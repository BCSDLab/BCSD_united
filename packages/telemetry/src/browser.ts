import { captureException, startSpan } from '@sentry/core';
import type { TelemetrySpan, TraceOptions } from './runtime-types';

export function captureError(error: unknown): string | undefined {
  return captureException(error);
}

export function traceOperation<T>(options: TraceOptions, task: (span: TelemetrySpan) => T): T {
  return startSpan(options, task);
}
