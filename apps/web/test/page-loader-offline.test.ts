import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { WEB_AUTH_CSRF_COOKIE_KEY } from '../src/static/url';

test('응답 없는 세션 실패는 최신 캐시를 사용하고 시계 표본을 생략한다', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test' } },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: `${WEB_AUTH_CSRF_COOKIE_KEY}=confirmed` },
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers')
        return {
          url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"preview",KOIN_API_ORIGIN:"https://api.stage.koreatech.in"}',
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  // APIClient의 브라우저 판별과 Cloudflare 모듈 대체를 먼저 설치한다.
  const { getClientRootSnapshot } = await import('../src/utils/ssr/pageLoader');
  const { initializeSessionConfirmation } = await import('../src/utils/auth/sessionConfirmation');
  const { SESSION_QUERY_KEY } = await import('../src/utils/auth/session');
  const { queryClient } = await import('../src/utils/ts/queryClient');
  initializeSessionConfirmation(true);
  t.after(() => queryClient.clear());
  queryClient.setQueryData(SESSION_QUERY_KEY, { status: 'authenticated', userType: 'STUDENT' });
  await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY, refetchType: 'none' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    queryClient.setQueryData(SESSION_QUERY_KEY, { status: 'anonymous' });
    throw new Error('offline');
  });
  const now = new Date(performance.timeOrigin + 10_000).toISOString();
  const result = await getClientRootSnapshot({
    device: 'desktop',
    isLoggedIn: true,
    userType: 'STUDENT',
    now,
    mayBeSharedCached: true,
  });
  assert.equal(calls, 1);
  assert.equal(result.serverRequest.userType, null);
  assert.ok(Math.abs(Date.parse(result.serverRequest.now) - (Date.now() + 10_000)) < 1000);
});
