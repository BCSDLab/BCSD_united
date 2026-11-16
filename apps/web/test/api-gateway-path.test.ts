import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('디코딩된 API 접두사는 upstream 요청을 만들지 않고 404로 거부한다', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers')
        return {
          url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"main",KOIN_API_ORIGIN:"https://api.koreatech.in"}',
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const apiFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Invalid gateway paths must not reach the API');
  });
  // 정적 import는 Node에 없는 Cloudflare 바인딩을 hook 설치 전에 읽으므로 이후에 불러온다.
  const { Route } = await import('../src/routes/api.$');
  const handlers = Route.options.server?.handlers as {
    GET: (context: { request: Request }) => Promise<Response>;
  };
  const response = await handlers.GET({ request: new Request('https://koreatech.in/%61pi') });
  assert.equal(response.status, 404);
  assert.equal(apiFetch.mock.callCount(), 0);
});
