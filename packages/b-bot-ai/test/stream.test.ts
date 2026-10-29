import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeResponseStream } from '../src/stream.ts';

function completed(text: string): string {
  return JSON.stringify({
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    },
  });
}

function stream(text: string, bytewise = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (bytewise) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}

test('SSE supports split UTF-8, CRLF, multi-line data and cumulative callbacks', async () => {
  const input = stream(
    ': keepalive\r\n\r\n' +
      'event: response.output_text.delta\r\ndata: {"delta":"안"}\r\n\r\n' +
      'event: response.output_text.delta\r\ndata: {\r\ndata: "delta":"녕"}\r\n\r\n' +
      `data: ${completed('안녕')}\r\n\r\ndata: [DONE]\r\n\r\n`,
    true,
  );
  const updates: string[] = [];
  assert.equal(await consumeResponseStream(input, (text) => updates.push(text)), '안녕');
  assert.deepEqual(updates, ['안', '안녕', '안녕']);
  assert.equal(input.locked, false);
});

test('SSE accepts bare CR lines and a final event without trailing blank line', async () => {
  assert.equal(
    await consumeResponseStream(stream(`event: response.completed\rdata: ${completed('final')}`), () => {}),
    'final',
  );
});

test('SSE ends at completed and cancels/releases an otherwise open stream', async () => {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${completed('final')}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(await consumeResponseStream(input, () => {}), 'final');
  assert.equal(cancelled, true);
  assert.equal(input.locked, false);
});

test('DONE and EOF without completion never return accumulated partial text', async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
  for (const suffix of ['', 'data: [DONE]\n\n']) {
    const input = stream(delta + suffix);
    await assert.rejects(
      consumeResponseStream(input, () => {}),
      /완료되지/,
    );
    assert.equal(input.locked, false);
  }
});

test('upstream failed, incomplete, refusal and error events reject after partial deltas', async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
  for (const [event, pattern] of [
    ['event: error\ndata: {"message":"secret-token"}\n\n', /요청 실패/],
    ['data: {"type":"response.failed","response":{"error":{"message":"secret-token"}}}\n\n', /요청 실패/],
    [
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      /출력 토큰 한도/,
    ],
    ['data: {"type":"response.refusal.delta","delta":"secret-token"}\n\n', /응답을 거부/],
    ['event: response.failed\n\n', /요청 실패/],
  ] as const) {
    const input = stream(delta + event);
    await assert.rejects(
      consumeResponseStream(input, () => {}),
      pattern,
    );
    assert.equal(input.locked, false);
  }
});

test('malformed stream JSON and UTF-8 reject safely', async () => {
  await assert.rejects(
    consumeResponseStream(stream('data: not-json-secret\n\n'), () => {}),
    /올바르지 않은 JSON/,
  );
  const invalidUtf8 = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
      controller.close();
    },
  });
  await assert.rejects(
    consumeResponseStream(invalidUtf8, () => {}),
    /UTF-8/,
  );
  assert.equal(invalidUtf8.locked, false);
});

test('a disconnected stream rejects and releases its reader', async () => {
  let sent = false;
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
        );
      } else {
        controller.error(new Error('secret-token'));
      }
    },
  });
  await assert.rejects(
    consumeResponseStream(input, () => {}),
    /연결이 중단/,
  );
  assert.equal(input.locked, false);
});

test('callback failures cancel and release the stream without masking the failure', async () => {
  const failure = new Error('callback failed');
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    consumeResponseStream(input, () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(cancelled, true);
  assert.equal(input.locked, false);
});
