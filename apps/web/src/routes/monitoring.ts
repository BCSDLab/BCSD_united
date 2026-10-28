import { dsnToString, getClient, handleTunnelRequest } from '@sentry/core';
import { createFileRoute } from '@tanstack/react-router';

const MAX_ENVELOPE_BYTES = 20 * 1024 * 1024;

async function readEnvelope(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) {
        await reader.cancel();

        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return body;
}

export const Route = createFileRoute('/monitoring')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const dsn = getClient()?.getDsn();
        const body = await readEnvelope(request);
        if (body === null || body.byteLength === 0) {
          return new Response(null, {
            status: body === null ? 413 : 400,
            headers: { 'Cache-Control': 'no-store' },
          });
        }

        // SDK는 Content-Length를 필수로 요구하므로 전송 방식과 무관하게 실제 바이트 수를 전달한다.
        const envelopeRequest = new Request(request.url, {
          method: 'POST',
          headers: { 'Content-Length': String(body.byteLength) },
          body,
        });
        const response = await handleTunnelRequest({
          request: envelopeRequest,
          allowedDsns: dsn ? [dsnToString(dsn)] : [],
        });
        const headers = new Headers({ 'Cache-Control': 'no-store' });

        ['content-type', 'retry-after', 'x-sentry-rate-limits'].forEach((name) => {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        });

        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
    },
  },
});
