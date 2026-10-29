import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStructured } from '../src/index.ts';
import { embeddingVector, parseStructured, responseText } from '../src/responses.ts';
import { upstreamError } from '../src/transport.ts';

function response(text: string): Record<string, unknown> {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: 'private reasoning' }] },
      { type: 'message', status: 'completed', content: [{ type: 'output_text', text }] },
    ],
  };
}

test('structured JSON uses message text without reasoning content', () => {
  assert.deepEqual(parseStructured(response('{"answer":"안녕"}')), { answer: '안녕' });
  assert.equal(responseText({ status: 'completed', output_text: 'shortcut' }), 'shortcut');
});

test('malformed and empty JSON produce safe user-visible errors', () => {
  assert.throws(() => parseStructured(response('{"key":"secret')), /올바른 JSON/);
  assert.throws(() => parseStructured(response('  ')), /빈 응답/);
  assert.throws(() => responseText(null), /응답 형식/);
});

test('refusal is not bypassed by an output_text shortcut', () => {
  assert.throws(
    () =>
      responseText({
        status: 'completed',
        output_text: '{"answer":"ignored"}',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'secret' }] }],
      }),
    /응답을 거부/,
  );
});

test('failed, incomplete and unfinished Responses never return partial text', () => {
  assert.throws(() => responseText({ ...response('partial'), status: 'failed' }), /요청 실패/);
  assert.throws(
    () =>
      responseText({
        ...response('partial'),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    /출력 토큰 한도/,
  );
  assert.throws(
    () =>
      responseText({
        ...response('partial'),
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }),
    /완료되지/,
  );
  assert.throws(() => responseText({ ...response('partial'), status: 'in_progress' }), /완료되지/);
});

test('structured image errors are reported before any external request', async () => {
  await assert.rejects(
    generateStructured({
      system: '',
      prompt: '',
      schema: {},
      images: [{ data: '  ', mimeType: 'image/png' }],
    }),
    /이미지 데이터가 비어/,
  );
  await assert.rejects(
    generateStructured({
      system: '',
      prompt: '',
      schema: {},
      images: [{ data: 'YWJj', mimeType: 'image/svg+xml' as 'image/png' }],
    }),
    /지원하지 않는 이미지/,
  );
});

test('embedding vectors require 1024 finite numeric coordinates', () => {
  const valid = Array.from({ length: 1024 }, (_, i) => i / 1024);
  assert.deepEqual(embeddingVector({ success: true, result: { data: [valid] } }), valid);
  for (const data of [
    undefined,
    [],
    [0],
    Array(1024),
    [...valid.slice(0, -1), Number.NaN],
    [...valid.slice(0, -1), Number.POSITIVE_INFINITY],
    [...valid.slice(0, -1), '0'],
    [...valid.slice(0, -1), null],
  ]) {
    assert.throws(() => embeddingVector({ data: [data] }), /유한한 숫자 1024개/);
  }
});

test('provider failures preserve actionable status without disclosing error payloads', () => {
  const secret = 'Bearer secret-token';
  const error = upstreamError({ status: 403, message: secret });
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /권한/);
  assert.ok(!error.message.includes(secret));
  assert.match(upstreamError({ code: 3036, message: secret }).message, /사용 한도·크레딧/);
  assert.match(upstreamError({ message: '2021: Insufficient AI Gateway credits' }).message, /사용 한도·크레딧/);
  assert.match(upstreamError({ code: 3040 }).message, /모델 용량/);
  assert.match(upstreamError(undefined, 429).message, /HTTP 429/);
  assert.throws(
    () => embeddingVector({ success: false, errors: [{ code: 3036, message: secret }] }),
    /자동 재시도나 다른 모델 전환은 하지 않습니다/,
  );
  assert.throws(
    () => responseText({ error: { message: secret } }),
    (error: unknown) => {
      return error instanceof Error && !error.message.includes(secret);
    },
  );
});
