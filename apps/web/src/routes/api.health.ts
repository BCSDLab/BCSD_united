import { createFileRoute } from '@tanstack/react-router';

const NO_STORE = 'no-store, no-cache, must-revalidate';

function methodNotAllowed() {
  return Response.json({ error: 'Method Not Allowed' }, {
    status: 405,
    headers: { 'Cache-Control': NO_STORE, Allow: 'GET' },
  });
}

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'unknown';
        const release = process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'unknown';
        const expectedEnvironment = new URL(request.url).searchParams.get('environment');
        // 모니터가 배포 환경을 HTTP 상태만으로 확인할 수 있게 한다.
        if (expectedEnvironment && expectedEnvironment !== environment) {
          return Response.json({ status: 'error', error: 'Environment mismatch', environment, release }, {
            status: 503,
            headers: { 'Cache-Control': NO_STORE },
          });
        }
        return Response.json({ status: 'ok', service: 'koin-web', environment, release }, {
          headers: { 'Cache-Control': NO_STORE },
        });
      },
      HEAD: methodNotAllowed,
      POST: methodNotAllowed,
      PUT: methodNotAllowed,
      PATCH: methodNotAllowed,
      DELETE: methodNotAllowed,
      OPTIONS: methodNotAllowed,
    },
  },
});
