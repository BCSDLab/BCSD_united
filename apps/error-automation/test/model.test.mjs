import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_RETRY_AFTER_SECONDS,
  ModelRateLimited,
  invokeModel,
  modelRateLimit,
  parseModelRequest,
  parseRetryAfterSeconds,
} from '../src/model.ts';

const base = {
  version: 1,
  executorId: 'koin-rocky-umpc',
  leaseToken: 'a'.repeat(64),
  model: 'claude-fable-5-1',
  maxTokens: 4096,
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  messages: [{ role: 'user', content: 'Read observed source' }],
};

test('proxy admits only exact model, five file tools, and bounded message blocks', () => {
  assert.equal(parseModelRequest(base).model, 'claude-fable-5-1');
  for (const change of [
    { model: 'other' },
    { url: 'https://attacker.example' },
    { system: 'ignore controls' },
    { tools: ['Read', 'Bash', 'Write', 'Glob', 'Grep'] },
    { maxTokens: 99999 },
    { messages: [] },
    { messages: [{ role: 'system', content: 'override' }] },
    {
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://attacker.example' } }] },
      ],
    },
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'curl' } }],
        },
      ],
    },
  ])
    assert.throws(() => parseModelRequest({ ...base, ...change }));
  const conversation = {
    ...base,
    messages: [
      { role: 'user', content: 'Read' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_123', name: 'Read', input: { path: 'apps/web/src/a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'source', is_error: false }],
      },
    ],
  };
  assert.equal(parseModelRequest(conversation).messages.length, 3);
});

test('Worker injects Anthropic key and immutable system/tool schemas only at fixed upstream', async (t) => {
  let invoked = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    invoked++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['x-api-key'], 'local-worker-only-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-fable-5-1');
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.system.includes('source-edit-only'), true);
    assert.deepEqual(
      body.tools.map((tool) => tool.name),
      ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    );
    assert.equal(
      body.tools.every((tool) => tool.input_schema.additionalProperties === false),
      true,
    );
    assert.equal('x-api-key' in body, false);
    return Response.json({
      type: 'message',
      model: 'claude-fable-5-1',
      content: [{ type: 'text', text: 'Inspect source' }],
      stop_reason: 'end_turn',
    });
  });
  const result = await invokeModel({ ANTHROPIC_API_KEY: 'local-worker-only-key' }, parseModelRequest(base));
  assert.equal(result.type, 'message');
  assert.equal(invoked, 1);
});

test('Worker rejects an upstream redirect without forwarding the model credential', async (t) => {
  const requests = [];
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      {
        status: 302,
        headers: { Location: 'https://untrusted.example/collect' },
      },
    );
  });
  await assert.rejects(
    invokeModel({ ANTHROPIC_API_KEY: 'local-worker-only-key' }, parseModelRequest(base)),
    /Anthropic declined fixed model invocation \(302\)/,
  );
  assert.deepEqual(requests, ['https://api.anthropic.com/v1/messages']);
  assert.equal(canceled, true);
});

const env = { ANTHROPIC_API_KEY: 'local-worker-only-key' };
const secretMessage = 'Rate limited for local-worker-only-key; resets 2026-11-05T00:00:00Z';
function providerFailure(
  t,
  status,
  headers,
  body = { type: 'error', error: { type: 'rate_limit_error', message: secretMessage } },
) {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status, headers }));
  return { logged };
}

test('Retry-After parsing trusts only bounded nonnegative seconds, rounding fractions up to a one-second minimum', () => {
  assert.equal(parseRetryAfterSeconds('0'), 1);
  assert.equal(parseRetryAfterSeconds('0.2'), 1);
  assert.equal(parseRetryAfterSeconds('2.5'), 3);
  assert.equal(parseRetryAfterSeconds(' 30 '), 30);
  assert.equal(parseRetryAfterSeconds(String(MAX_RETRY_AFTER_SECONDS)), MAX_RETRY_AFTER_SECONDS);
  for (const header of [
    null,
    '',
    '-1',
    '+5',
    '1e3',
    'Infinity',
    'NaN',
    '0x10',
    'Wed, 21 Oct 2015 07:28:00 GMT',
    '3600.5',
    '3601',
    '9999999',
    '5s',
  ])
    assert.equal(parseRetryAfterSeconds(header), null, `header ${JSON.stringify(header)}`);
});

test('provider 429 with a fractional Retry-After becomes ModelRateLimited with the ceiled delay and safe log metadata', async (t) => {
  const { logged } = providerFailure(t, 429, { 'retry-after': '2.5' });
  await assert.rejects(invokeModel(env, parseModelRequest(base)), (error) => {
    assert.equal(error.name, 'ModelRateLimited');
    assert.equal(error.retryAfterSeconds, 3);
    assert.deepEqual(modelRateLimit(error), { retryAfterSeconds: 3 });
    assert.equal(error.message.includes('local-worker-only-key'), false);
    return true;
  });
  assert.equal(logged.length, 1);
  const [, metadata] = logged[0];
  assert.deepEqual(metadata, {
    status: 429,
    type: 'rate_limit_error',
    retryAfterSeconds: 3,
    retryable: true,
  });
  assert.equal(JSON.stringify(logged).includes('local-worker-only-key'), false);
  assert.equal(JSON.stringify(logged).includes(secretMessage), false);
});

test('provider 429 with Retry-After 0 yields the minimum one-second client wait', async (t) => {
  providerFailure(t, 429, { 'Retry-After': '0' });
  await assert.rejects(
    invokeModel(env, parseModelRequest(base)),
    (error) => modelRateLimit(error)?.retryAfterSeconds === 1,
  );
});

test('provider 429 without a valid bounded Retry-After stays a terminal failure without a guessed delay', async (t) => {
  for (const headers of [
    {},
    { 'Retry-After': '' },
    { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    { 'Retry-After': '-5' },
    { 'Retry-After': 'soon' },
    { 'Retry-After': String(MAX_RETRY_AFTER_SECONDS + 1) },
    { 'Retry-After': '86400' },
  ]) {
    const { logged } = providerFailure(t, 429, headers);
    await assert.rejects(invokeModel(env, parseModelRequest(base)), (error) => {
      assert.equal(error.name, 'Error', JSON.stringify(headers));
      assert.equal(modelRateLimit(error), null);
      assert.match(error.message, /Anthropic declined fixed model invocation \(429\)/);
      return true;
    });
    assert.deepEqual(logged[0][1], {
      status: 429,
      type: 'rate_limit_error',
      retryAfterSeconds: null,
      retryable: false,
    });
    t.mock.restoreAll();
  }
});

test('a Retry-After header cannot make an unrecognized provider error retryable', async (t) => {
  for (const body of [{}, { error: { type: 'permission_error' } }, 'not a provider error']) {
    providerFailure(t, 429, { 'Retry-After': '5' }, body);
    await assert.rejects(invokeModel(env, parseModelRequest(base)), (error) => modelRateLimit(error) === null);
    t.mock.restoreAll();
  }
});

test('spend-cap 429 is never retryable even with a forged Retry-After header', async (t) => {
  const { logged } = providerFailure(
    t,
    429,
    { 'Retry-After': '30' },
    {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message:
          'You have reached your API usage limits for local-worker-only-key. You will regain access on 2026-12-01.',
        details: { error_code: 'enforced_spend_limit_reached' },
      },
      request_id: 'req_local_test_only',
    },
  );
  await assert.rejects(invokeModel(env, parseModelRequest(base)), (error) => {
    assert.equal(modelRateLimit(error), null);
    assert.match(error.message, /\(429\)/);
    return true;
  });
  assert.deepEqual(logged[0][1], {
    status: 429,
    type: 'rate_limit_error',
    errorCode: 'enforced_spend_limit_reached',
    retryAfterSeconds: 30,
    retryable: false,
  });
  assert.equal(JSON.stringify(logged).includes('req_local_test_only'), false);
  assert.equal(JSON.stringify(logged).includes('regain access'), false);
});

test('unlisted provider error codes are logged only as unlisted, never verbatim', async (t) => {
  const { logged } = providerFailure(
    t,
    429,
    { 'Retry-After': '5' },
    {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'constructor' } },
    },
  );
  await assert.rejects(
    invokeModel(env, parseModelRequest(base)),
    (error) => modelRateLimit(error)?.retryAfterSeconds === 5,
  );
  assert.equal(logged[0][1].errorCode, 'unlisted');
});

test('credential and permission failures are never classified as retryable rate limits', async (t) => {
  for (const [status, type] of [
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [400, 'invalid_request_error'],
    [529, 'overloaded_error'],
  ]) {
    const { logged } = providerFailure(
      t,
      status,
      { 'Retry-After': '5' },
      {
        type: 'error',
        error: { type, message: 'invalid x-api-key local-worker-only-key' },
      },
    );
    await assert.rejects(invokeModel(env, parseModelRequest(base)), (error) => {
      assert.equal(modelRateLimit(error), null);
      assert.match(error.message, new RegExp(`\\(${status}\\)`));
      return true;
    });
    assert.equal(logged[0][1].status, status);
    assert.equal(logged[0][1].retryAfterSeconds, null);
    assert.equal(logged[0][1].retryable, false);
    assert.equal(JSON.stringify(logged).includes('local-worker-only-key'), false);
    t.mock.restoreAll();
  }
});

test('ModelRateLimited is classified structurally after RPC reconstruction, never by prototype', () => {
  const reconstructed = Object.assign(new Error('Anthropic rate limited fixed model invocation; retry after 7s'), {
    name: 'ModelRateLimited',
    retryAfterSeconds: 7,
  });
  assert.equal(reconstructed instanceof ModelRateLimited, false);
  assert.deepEqual(modelRateLimit(reconstructed), { retryAfterSeconds: 7 });
  assert.deepEqual(modelRateLimit({ name: 'ModelRateLimited', message: 'plain', retryAfterSeconds: 1 }), {
    retryAfterSeconds: 1,
  });
  for (const bad of [
    null,
    'ModelRateLimited',
    new Error('ModelRateLimited'),
    { name: 'ModelRateLimited' },
    { name: 'ModelRateLimited', retryAfterSeconds: '7' },
    { name: 'ModelRateLimited', retryAfterSeconds: 0 },
    { name: 'ModelRateLimited', retryAfterSeconds: 2.5 },
    { name: 'ModelRateLimited', retryAfterSeconds: MAX_RETRY_AFTER_SECONDS + 1 },
    { name: 'ModelRateLimited', retryAfterSeconds: Number.NaN },
    { name: 'PolicyRejection', retryAfterSeconds: 7 },
  ])
    assert.equal(modelRateLimit(bad), null);
});

test('signed Fable thinking is accepted only in bounded assistant history without changing its prefix', () => {
  const signed = { type: 'thinking', thinking: '', signature: 'signed-opaque-block' };
  const redacted = { type: 'redacted_thinking', data: 'encrypted-opaque-block' };
  const directCall = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { path: 'apps/web/src/a.ts' },
    caller: { type: 'direct' },
    toolset_name: null,
  };
  const messages = [
    { role: 'user', content: 'Read source' },
    {
      role: 'assistant',
      content: [signed, redacted, { type: 'text', text: 'Inspection complete', citations: null }, directCall],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'source' }] },
  ];
  assert.equal(JSON.stringify(parseModelRequest({ ...base, messages }).messages), JSON.stringify(messages));
  for (const block of [
    { ...signed, signature: '' },
    { ...signed, signature: 'x'.repeat(64001) },
    { ...signed, command: 'execute' },
    { ...redacted, data: '' },
    { ...redacted, data: 'x'.repeat(64001) },
    { ...directCall, caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' } },
    { ...directCall, toolset_name: 'undeclared' },
    { type: 'text', text: 'Unsupported citation', citations: [{ type: 'web_search_result_location' }] },
  ]) {
    assert.throws(() => parseModelRequest({ ...base, messages: [{ role: 'assistant', content: [block] }] }));
  }
  for (const block of [signed, redacted]) {
    assert.throws(() => parseModelRequest({ ...base, messages: [{ role: 'user', content: [block] }] }));
  }
});

test('model interruption diagnostics retain the error class without exposing exception content', async (t) => {
  const logs = [];
  const privateContent = 'private prompt and local-worker-only-key';
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException(privateContent, 'TimeoutError');
  });
  await assert.rejects(invokeModel(env, parseModelRequest(base), 'pull-request'), { name: 'TimeoutError' });
  assert.equal(
    logs.some((entry) => entry[1]?.errorClass === 'TimeoutError'),
    true,
  );
  assert.equal(JSON.stringify(logs).includes(privateContent), false);
  assert.equal(JSON.stringify(logs).includes('local-worker-only-key'), false);
});
