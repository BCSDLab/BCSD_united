import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { WEB_AUTH_CSRF_COOKIE_KEY } from '../src/static/url';

test('세션 조회 실패 시 확인된 쿠키의 캐시만 유지한다', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test' } },
  });
  const document = { cookie: `${WEB_AUTH_CSRF_COOKIE_KEY}=confirmed` };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return {
          url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"preview",KOIN_API_ORIGIN:"https://api.stage.koreatech.in"}',
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('{}', { status: 500, headers: { Date: new Date().toUTCString() } }),
  );
  // APIClient가 로딩 시 브라우저 여부를 결정하므로 브라우저 전역을 설치한 뒤 가져온다.
  const { getClientRootSnapshot } = await import('../src/utils/ssr/pageLoader');
  const { initializeSessionConfirmation } = await import('../src/utils/auth/sessionConfirmation');
  const { SESSION_QUERY_KEY } = await import('../src/utils/auth/session');
  const { queryClient } = await import('../src/utils/ts/queryClient');
  initializeSessionConfirmation(true);
  t.after(() => queryClient.clear());
  queryClient.setQueryData(SESSION_QUERY_KEY, { status: 'authenticated', userType: 'STUDENT' });
  await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY, refetchType: 'none' });
  const input = {
    device: 'desktop',
    isLoggedIn: true,
    userType: 'STUDENT',
    now: new Date().toISOString(),
    mayBeSharedCached: false,
  } as const;
  const confirmed = await getClientRootSnapshot(input);
  assert.equal(confirmed.serverRequest.userType, 'STUDENT');
  document.cookie = `${WEB_AUTH_CSRF_COOKIE_KEY}=other`;
  const unconfirmed = await getClientRootSnapshot(input);
  assert.equal(unconfirmed.serverRequest.userType, null);
});
