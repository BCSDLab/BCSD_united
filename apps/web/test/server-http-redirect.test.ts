import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('public requests use the canonical HTTPS origin before SSR while local origins remain available', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return { url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"main"}', shortCircuit: true };
      }
      if (specifier === '@tanstack/react-start/server') {
        return {
          url: 'data:text/javascript,export const createStartHandler = () => async () => new Response(null); export const defaultStreamHandler = () => {}',
          shortCircuit: true,
        };
      }
      if (specifier === '@tanstack/react-start/server-entry') {
        return { url: 'data:text/javascript,export const createServerEntry = entry => entry', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  // 모듈 로드 전 Cloudflare 및 React Start 의존성을 모의하기 위해 동적 import가 필요하다.
  t.after(() => hooks.deregister());
  const { default: server } = await import('../src/server');

  for (const host of ['koreatech.in', 'stage.koreatech.in']) {
    for (const origin of [`http://${host}`, `http://${host}:8080`, `https://${host}:2053`]) {
      const response = await server.fetch(new Request(`${origin}/articles/20632?search=test%20value&sort=recent`));
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('Location'), `https://${host}/articles/20632?search=test%20value&sort=recent`);
    }

    const post = await server.fetch(new Request(`http://${host}/api/articles`, { method: 'POST' }));
    assert.equal(post.status, 308);
    assert.equal(post.headers.get('Location'), `https://${host}/api/articles`);
  }

  for (const url of ['http://localhost:3000/', 'http://koin-web.example.workers.dev/', 'https://koreatech.in/']) {
    const response = await server.fetch(new Request(url));
    assert.equal(response.status, 200);
  }
});
