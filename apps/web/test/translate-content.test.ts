import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test, type TestContext } from 'node:test';

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { hang: true };

async function setup(t: TestContext, replies: Reply[]) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test', protocol: 'https:' } },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
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
  const queue = [...replies];
  t.mock.method(globalThis, 'fetch', async (input: Request | string) => {
    const request = typeof input === 'string' ? new Request(input) : input;
    requested.push(`${request.method} ${new URL(request.url).pathname}`);
    const reply = queue.shift();
    if (!reply) throw new Error('unexpected request');
    if ('hang' in reply) {
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  });
  // APIClient가 로딩 시 브라우저 여부를 결정하므로 브라우저 전역을 설치한 뒤 가져온다.
  const { translateContent } = await import('../src/utils/translation/translateContent');

  return { translateContent, requested };
}

const result = (status: string, extra: Record<string, unknown> = {}) => ({
  translation_id: 'tr-1',
  status,
  target_language: 'en-US',
  source_version: 'v1',
  reason_code: null,
  retryable: false,
  data: null,
  ...extra,
});

const options = (refetchSourceVersion = async () => 'v2') => ({
  path: '/articles/lost-item/1/translations',
  targetLanguage: 'en-US',
  sourceVersion: 'v1',
  refetchSourceVersion,
  wait: async () => {},
});

test('번역이 바로 끝나면 번역문을 돌려준다', async (t) => {
  const { translateContent } = await setup(t, [{ status: 200, body: result('SUCCESS', { data: { content: 'Hi' } }) }]);
  assert.deepEqual(await translateContent(options()), {
    kind: 'success',
    data: { content: 'Hi' },
    sourceVersion: 'v1',
  });
});

test('진행 중이면 결과를 다시 조회해 번역문을 돌려준다', async (t) => {
  const { translateContent, requested } = await setup(t, [
    { status: 202, body: result('PENDING'), headers: { 'Retry-After': '1' } },
    { status: 200, body: result('PENDING') },
    { status: 200, body: result('SUCCESS', { data: { content: 'Hi' } }) },
  ]);
  const outcome = await translateContent(options());
  assert.equal(outcome.kind, 'success');
  assert.deepEqual(requested, [
    'POST /articles/lost-item/1/translations',
    'GET /translations/tr-1',
    'GET /translations/tr-1',
  ]);
});

test('원문이 바뀌었으면(409) 원문 버전을 다시 받아 한 번 더 요청한다', async (t) => {
  const { translateContent } = await setup(t, [
    { status: 409, body: { code: 'SOURCE_CHANGED', message: '원문이 변경되었습니다.' } },
    { status: 200, body: result('SUCCESS', { source_version: 'v2', data: { content: 'Hi' } }) },
  ]);
  let refetched = 0;
  const outcome = await translateContent(
    options(async () => {
      refetched += 1;
      return 'v2';
    }),
  );
  assert.equal(refetched, 1);
  assert.deepEqual(outcome, { kind: 'success', data: { content: 'Hi' }, sourceVersion: 'v2' });
});

test('제공할 수 없으면 unavailable, 실패하면 failed를 돌려준다', async (t) => {
  const { translateContent } = await setup(t, [
    { status: 422, body: result('UNAVAILABLE', { translation_id: null, reason_code: 'UNSUPPORTED_CONTENT' }) },
    { status: 502, body: result('FAILED', { reason_code: 'MISSING_TRANSLATION' }) },
    { status: 200, body: result('UNAVAILABLE', { translation_id: null }) },
  ]);
  assert.deepEqual(await translateContent(options()), { kind: 'unavailable' });
  assert.deepEqual(await translateContent(options()), { kind: 'failed' });
  assert.deepEqual(await translateContent(options()), { kind: 'unavailable' });
});

test('번역 결과 형식의 오류 응답은 HTTP 상태보다 본문 status를 따른다', async (t) => {
  const { translateContent } = await setup(t, [
    { status: 422, body: result('FAILED', { translation_id: null, retryable: true }) },
    { status: 404, body: { code: 'NOT_FOUND', message: '원문이 없습니다.' } },
  ]);
  assert.deepEqual(await translateContent(options()), { kind: 'failed' });
  assert.deepEqual(await translateContent(options()), { kind: 'failed' });
});

test('번역 요청은 기한까지 남은 시간만 기다린다', async (t) => {
  const { translateContent, requested } = await setup(t, [{ hang: true }]);
  // 기한 30초 중 29.95초가 지난 뒤 나간 요청은 응답이 없어도 남은 50ms만 기다리고 끝낸다
  let started = false;
  t.mock.method(Date, 'now', () => {
    if (started) return 29_950;
    started = true;

    return 0;
  });
  const startedAt = performance.now();
  const outcome = await translateContent(options());
  assert.deepEqual(outcome, { kind: 'failed' });
  assert.equal(requested.length, 1);
  // 기본 timeout(20초)까지 기다리지 않는다
  assert.ok(performance.now() - startedAt < 5_000);
});

test('진행 중 상태가 30초를 넘기면 실패로 본다', async (t) => {
  const pending = { status: 200, body: result('PENDING'), headers: { 'Retry-After': '40' } };
  const { translateContent, requested } = await setup(t, [{ ...pending, status: 202 }, pending, pending, pending]);
  // 기다린 시간만큼 시계를 앞당긴다. Retry-After는 최대 10초로 잘라 쓴다.
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const outcome = await translateContent({
    ...options(),
    wait: async (ms: number) => {
      now += ms;
    },
  });
  assert.deepEqual(outcome, { kind: 'failed' });
  assert.equal(requested.length, 4);
});

test('Retry-After가 0이어도 최소 1초는 기다린다', async (t) => {
  const { translateContent } = await setup(t, [
    { status: 202, body: result('PENDING'), headers: { 'Retry-After': '0' } },
    { status: 200, body: result('SUCCESS', { data: { content: 'Hi' } }) },
  ]);
  const waited: number[] = [];
  const outcome = await translateContent({
    ...options(),
    wait: async (ms: number) => {
      waited.push(ms);
    },
  });
  assert.equal(outcome.kind, 'success');
  assert.deepEqual(waited, [1000]);
});

test('다음 조회 시점이 기한을 넘기면 기한까지만 기다렸다가 한 번 더 조회한다', async (t) => {
  const { translateContent, requested } = await setup(t, [
    { status: 202, body: result('PENDING'), headers: { 'Retry-After': '10' } },
    { status: 200, body: result('SUCCESS', { data: { content: 'Hi' } }) },
  ]);
  // 기한 30초 중 첫 요청에 25초가 걸려, Retry-After 10초 대신 남은 5초만 기다린다
  let now = 25_000;
  let started = false;
  t.mock.method(Date, 'now', () => {
    if (started) return now;
    started = true;

    return 0;
  });
  const waited: number[] = [];
  const outcome = await translateContent({
    ...options(),
    wait: async (ms: number) => {
      waited.push(ms);
      now += ms;
    },
  });
  assert.equal(outcome.kind, 'success');
  assert.deepEqual(waited, [5000]);
  assert.equal(requested.length, 2);
});

test('화면을 떠나 요청을 멈추면 더 조회하지 않는다', async (t) => {
  const { translateContent, requested } = await setup(t, [
    { status: 202, body: result('PENDING'), headers: { 'Retry-After': '2' } },
  ]);
  const controller = new AbortController();
  const outcome = await translateContent({
    ...options(),
    signal: controller.signal,
    wait: async () => {
      controller.abort();
    },
  });
  assert.deepEqual(outcome, { kind: 'aborted' });
  assert.deepEqual(requested, ['POST /articles/lost-item/1/translations']);
});

test('원문을 다시 받는 동안 요청을 멈추면 다시 요청하지 않는다', async (t) => {
  const { translateContent, requested } = await setup(t, [
    { status: 409, body: { code: 'SOURCE_CHANGED', message: '원문이 변경되었습니다.' } },
  ]);
  const controller = new AbortController();
  const outcome = await translateContent({
    ...options(async () => {
      controller.abort();
      return 'v2';
    }),
    signal: controller.signal,
  });
  assert.deepEqual(outcome, { kind: 'aborted' });
  assert.equal(requested.length, 1);
});
