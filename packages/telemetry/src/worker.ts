import { tracing } from 'cloudflare:workers';
import { maskSensitive } from './index';
import type { TelemetrySpan, TraceOptions } from './runtime-types';

export function captureError(error: unknown): string | undefined {
  if (error instanceof Error) {
    const safeError = new Error(maskSensitive(error.message));
    safeError.name = error.name;
    safeError.stack = maskSensitive(error.stack);
    console.error(safeError);
  } else {
    console.error(maskSensitive(error));
  }

  return undefined;
}

export function traceOperation<T>(options: TraceOptions, task: (span: TelemetrySpan) => T): T {
  return tracing.enterSpan(options.name, (span) => {
    if (options.op) span.setAttribute('operation', options.op);
    if (options.attributes) span.setAttributes(options.attributes);

    return task(span);
  });
}
