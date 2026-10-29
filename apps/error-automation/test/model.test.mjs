import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModelRequest, invokeModel } from '../src/model.ts';

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
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-api-key'], 'local-worker-only-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-fable-5-1');
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.temperature, 0);
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
