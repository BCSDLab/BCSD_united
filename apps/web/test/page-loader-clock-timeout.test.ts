import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('공유 문서의 응답 없는 시계 표본은 짧은 타임아웃 뒤 SSR 기준 오프셋을 사용한다', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test' } },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
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
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}));
  // APIClient의 브라우저 판별과 Cloudflare 모듈 대체를 먼저 설치한다.
  const { getClientRootSnapshot } = await import('../src/utils/ssr/pageLoader');
  const start = performance.now();
  const now = new Date(performance.timeOrigin + 10_000).toISOString();
  const result = await getClientRootSnapshot({
    device: 'desktop',
    isLoggedIn: false,
    userType: null,
    now,
    mayBeSharedCached: true,
  });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 2000 && elapsed < 5000, `elapsed: ${elapsed}`);
  assert.ok(Math.abs(Date.parse(result.serverRequest.now) - (Date.now() + 10_000)) < 1000);
});
