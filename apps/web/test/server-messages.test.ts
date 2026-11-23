import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('서버 렌더 대기 시간을 넘긴 사전 응답도 캐시에 저장해 다음 요청에서 쓴다', async (t) => {
  const pending: Promise<unknown>[] = [];
  Object.defineProperty(globalThis, '__waitUntil', { configurable: true, value: pending });
  t.after(() => Reflect.deleteProperty(globalThis, '__waitUntil'));
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return {
          url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"preview",KOIN_API_ORIGIN:"https://api.stage.koreatech.in"}; export const waitUntil = (promise) => globalThis.__waitUntil.push(promise);',
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());

  const dictionary = { found_status: { FOUND: 'Found' } };
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requestCount += 1;
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });

    return new Response(JSON.stringify(dictionary), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const { getServerMessages } = await import('../src/utils/language/serverMessages');

  assert.equal(await getServerMessages('en-US'), null);
  assert.equal(pending.length, 1);
  await Promise.all(pending);

  assert.deepEqual(await getServerMessages('en-US'), dictionary);
  assert.equal(requestCount, 1);
});
