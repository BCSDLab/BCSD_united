import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const R2 = 'https://files.example.test/uploads/';
const PREVIEW_R2 = 'https://pub-035732b521844e3b9205d80d8d6efda1.r2.dev';

test('image API enforces R2 source boundaries, redirects and cache policy', async (t) => {
  const upstream = new Map<string, () => Response>();
  const fetched: string[] = [];
  const entries = new Map<string, Response>();
  let opens = 0;
  let writes = 0;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async (name: string) => {
        assert.equal(name, 'images-v1');
        opens++;
        return {
          match: async (request: Request) => entries.get(request.url)?.clone(),
          put: async (request: Request, response: Response) => {
            writes++;
            entries.set(request.url, response);
          },
        };
      },
    },
  });
  t.after(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else Reflect.deleteProperty(globalThis, 'caches');
  });

  const env = {
    KOIN_ENVIRONMENT: 'main',
    R2_FILES_PUBLIC_URL: '',
    ASSETS: { fetch: async () => new Response('asset') },
    IMAGES: {
      input: (stream: ReadableStream<Uint8Array>) => ({
        transform: () => ({
          output: async () => {
            await new Response(stream).arrayBuffer();
            return { response: ({ headers }: { headers: HeadersInit }) => new Response('converted', { headers }) };
          },
        }),
      }),
    },
  };
  Object.assign(globalThis, { __imageTestEnv: env });
  t.after(() => Reflect.deleteProperty(globalThis, '__imageTestEnv'));
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers')
        return { url: 'data:text/javascript,export const env = globalThis.__imageTestEnv', shortCircuit: true };
      if (specifier === '@tanstack/react-router')
        return {
          url: 'data:text/javascript,export const createFileRoute = () => options => options',
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  // The route must be imported after the Cloudflare and Router module hooks are installed.
  const { Route } = await import('../src/routes/api.image');
  // The router stub returns route options directly instead of a TanStack Route instance.
  const stubbedRoute = Route as unknown as {
    server: { handlers: { GET: (args: { request: Request }) => Promise<Response> } };
  };
  const handler = stubbedRoute.server.handlers.GET;
  const image = (source: string, headers?: HeadersInit) =>
    handler({
      request: new Request(
        `https://koreatech.in/api/image?${new URLSearchParams({ url: source, w: '128', q: '75' })}`,
        { headers },
      ),
    });
  t.mock.method(globalThis, 'fetch', async (target: string | URL | Request) => {
    const url = String(target);
    fetched.push(url);
    return (upstream.get(url) ?? (() => new Response('image')))();
  });

  const legacy = 'https://static.koreatech.in/legacy.png';
  assert.equal((await image('https://files.example.test/uploads/a.png')).status, 400);
  assert.equal((await image('https://koreatech.in/private.png')).status, 400);
  assert.equal(
    (await image('https://koreatech.in/assets/a.png')).headers.get('Cache-Control'),
    'public, max-age=2678400',
  );
  const firstLegacy = await image(legacy);
  assert.equal(firstLegacy.headers.get('Cache-Control'), 'public, max-age=2678400');
  assert.equal(writes, 2);
  const legacyCalls = fetched.length;
  assert.equal((await image(legacy)).status, 200);
  assert.equal(fetched.length, legacyCalls);
  assert.equal(writes, 2);
  assert.equal((await image(PREVIEW_R2 + '/old.png')).status, 400);
  env.KOIN_ENVIRONMENT = 'preview';
  assert.equal((await image(PREVIEW_R2 + '/old.png')).status, 200);
  env.KOIN_ENVIRONMENT = 'main';

  env.R2_FILES_PUBLIC_URL = R2;
  const r2 = `${R2}private.png?version=1`;
  const beforeR2 = { opens, writes, fetched: fetched.length };
  for (let i = 0; i < 2; i++) {
    const response = await image(r2);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Vary'), 'Accept');
  }
  assert.equal(opens, beforeR2.opens);
  assert.equal(writes, beforeR2.writes);
  assert.equal(fetched.length, beforeR2.fetched + 2);
  assert.equal((await image(`${R2}safe%20name.png`)).headers.get('Cache-Control'), 'no-store');
  assert.equal((await image(`${R2}100%25.png`)).headers.get('Cache-Control'), 'no-store');

  for (const source of [
    'https://files.example.test/uploaded/a.png',
    'https://files.example.test/uploads-other/a.png',
    'https://files.example.test.evil.test/uploads/a.png',
    'http://files.example.test/uploads/a.png',
    'https://user@files.example.test/uploads/a.png',
    'https://files.example.test:443/uploads/a.png',
    'https://files.example.test:8443/uploads/a.png',
    'https://files.example.test/uploads/%2e%2e/private.png',
    'https://files.example.test/uploads/%2e%2e%2fprivate.png',
    'https://files.example.test/uploads/%252e%252e%252fprivate.png',
    'https://files.example.test/uploads/%5cprivate.png',
    'https://files.example.test/uploads/%00private.png',
    'https://files.example.test/uploads/a.png#fragment',
  ]) {
    const before = fetched.length;
    assert.equal((await image(source)).status, 400, source);
    assert.equal(fetched.length, before, source);
  }

  const redirected = `${R2}redirect.png`;
  upstream.set(redirected, () => Response.redirect(`${R2}destination.png`, 302));
  const redirectResponse = await image(redirected);
  assert.equal(redirectResponse.status, 200);
  assert.equal(redirectResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal(writes, beforeR2.writes);
  const escaped = `${R2}escape.png`;
  upstream.set(escaped, () => Response.redirect('https://static.koreatech.in/legacy.png', 302));
  const beforeEscape = fetched.length;
  assert.equal((await image(escaped)).status, 502);
  assert.deepEqual(fetched.slice(beforeEscape), [escaped]);
  const legacyRedirect = 'https://static.koreatech.in/redirect-to-r2.png';
  upstream.set(legacyRedirect, () => Response.redirect(`${R2}private.png`, 302));
  const beforeLegacyRedirect = fetched.length;
  assert.equal((await image(legacyRedirect)).status, 502);
  assert.deepEqual(fetched.slice(beforeLegacyRedirect), [legacyRedirect]);
  assert.equal(writes, beforeR2.writes);
  for (const destination of [
    'https://files.example.test/uploads-other/not-an-upload.png',
    'https://files.example.test/uploads/%2e%2e%2fprivate.png',
    'https://files.example.test/uploads/%252e%252e%252fprivate.png',
    'https://files.example.test/uploads/%5cprivate.png',
    'https://files.example.test/uploads/%00private.png',
    'https://files.example.test:443/uploads/port.png',
    '//files.example.test:443/uploads/protocol-relative.png',
    'https://other.example.test/uploads/foreign.png',
    'https://user@files.example.test/uploads/userinfo.png',
  ]) {
    const source = `${R2}redirect-${fetched.length}.png`;
    upstream.set(source, () => new Response(null, { status: 302, headers: { Location: destination } }));
    const before = fetched.length;
    const response = await image(source);
    assert.equal(response.status, 502, destination);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(fetched.slice(before), [source], destination);
  }
  const oldRedirect = 'https://static.koreatech.in/redirect-to-old.png';
  upstream.set(oldRedirect, () => Response.redirect('https://stage-static.koreatech.in/old.png', 302));
  assert.equal((await image(oldRedirect)).headers.get('Cache-Control'), 'public, max-age=2678400');
  env.R2_FILES_PUBLIC_URL = 'https://static.koreatech.in/uploads/';
  assert.equal(
    (await image('https://static.koreatech.in/legacy-s3.png')).headers.get('Cache-Control'),
    'public, max-age=2678400',
  );
  assert.equal((await image('https://static.koreatech.in/uploads/new.png')).headers.get('Cache-Control'), 'no-store');
  assert.equal((await image('https://static.koreatech.in/uploads/%252e%252e%252fprivate.png')).status, 400);

  for (const setting of [
    'http://files.example.test/uploads/',
    'https://user@files.example.test/uploads/',
    'https://files.example.test:443/uploads/',
    'https://files.example.test:8443/uploads/',
    'https://files.example.test/uploads/?token=1',
    'https://files.example.test/uploads/#fragment',
    'https://files.example.test/uploads/../public/',
    'https://files.example.test/uploads/%252e/',
    'https://files.example.test/uploads/%2f/',
    'https://files.example.test.evil.test:443/uploads/',
  ]) {
    env.R2_FILES_PUBLIC_URL = setting;
    const before = fetched.length;
    assert.equal((await image(legacy)).status, 503, setting);
    assert.equal(fetched.length, before, setting);
  }
});
