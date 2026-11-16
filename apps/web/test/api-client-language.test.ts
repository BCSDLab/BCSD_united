import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { LANGUAGE_COOKIE_KEY } from '../src/static/url';

test('언어 쿠키가 한국어가 아니면 번역 조회에만 language 쿼리를 붙인다', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test', protocol: 'https:' } },
  });
  const document = { cookie: '' };
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
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Request | string) => {
    requested.push(typeof input === 'string' ? input : input.url);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  // APIClient가 로딩 시 브라우저 여부를 결정하므로 브라우저 전역을 설치한 뒤 가져온다.
  const { getStoreCategories } = await import('../src/api/store');
  const { getUserProfile } = await import('../src/api/auth');

  document.cookie = `${LANGUAGE_COOKIE_KEY}=en-US`;
  await getStoreCategories();
  await getUserProfile().catch(() => undefined);
  assert.match(requested[0], /\/shops\/categories\?language=en-US$/);
  assert.doesNotMatch(requested[1], /language=/);

  document.cookie = `${LANGUAGE_COOKIE_KEY}=ko-KR`;
  await getStoreCategories();
  assert.doesNotMatch(requested[2], /language=/);
});
