import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const platform =
  'data:text/javascript,' +
  encodeURIComponent('export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: platform, shortCircuit: true };
    if (
      specifier.startsWith('./') &&
      context.parentURL?.includes('/apps/error-automation/src/') &&
      !specifier.endsWith('.ts')
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { default: worker, AutofixQueue } = await import('../src/index.ts');
const { requestText, requestRegressionPath, requestSourcePath, REQUEST_CHECKS, REQUEST_SCOPE } =
  await import('../src/request.ts');
const { parseClaim, generateAnswer } = await import('../../../scripts/autofix/executor.mjs');
const { requestToolScope, sourceTools } = await import('../../../scripts/autofix/executor-model.mjs');
const {
  REQUEST_CHECKS: executorChecks,
  REQUEST_SCOPE: executorScope,
  requestRegressionPath: executorRegressionPath,
  requestSourcePath: executorSourcePath,
} = await import('../../../scripts/autofix/common.mjs');
const { forwardAutofixMention } = await import('../../b-bot/src/services/slack/autofix.ts');
const secret = 'local-slack-signing-secret-32-characters';
const baseSha = 'a'.repeat(40);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const event = (text = '<@UBOT> 수정요청 게시글 사진 표시 오류를 고쳐 주세요') => ({
  type: 'event_callback',
  team_id: 'TTEAM',
  event_id: 'EvRequest1',
  event: { type: 'app_mention', user: 'UALLOWED', channel: 'CALLOWED', ts: '1700000000.000001', text },
});
function signed(data = event(), timestamp = String(Math.floor(Date.now() / 1000))) {
  return signedBody(JSON.stringify(data), timestamp);
}
function signedBody(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  return new Request('https://automation.example/slack/requests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`,
    },
    body,
  });
}
function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: {
      exec(query, ...values) {
        const stmt = db.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    sync: async () => {},
    setAlarm: async () => {},
  };
  const env = {
    ENVIRONMENT: 'production',
    SENTRY_CLIENT_SECRET: 'local-sentry',
    SENTRY_ORGANIZATION: 'bcsd',
    SENTRY_PROJECT_APPS: '{"koin-united-prod":"web"}',
    SENTRY_PROJECT_HOSTS: '{"koin-united-prod":["koreatech.in"]}',
    ERROR_SOURCE_BRANCHES: '{"sentry:koin-united-prod":"main"}',
    CLOUDFLARE_SOURCES: '[]',
    DIAGNOSTICS_READ_TOKEN: 'local-diagnostics-secret-32-characters',
    GITHUB_OWNER: 'BCSDLab',
    GITHUB_REPOSITORY: 'BCSD_united',
    GITHUB_DISPATCH_APP_ID: '5522353',
    GITHUB_DISPATCH_INSTALLATION_ID: '176455083',
    GITHUB_DISPATCH_APP_PRIVATE_KEY: key,
    AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc',
    AUTOFIX_EXECUTOR_TOKEN: 'local-executor-secret-at-least-32-characters',
    SLACK_BOT_SIGNING_SECRET: secret,
    SLACK_AUTOFIX_TEAM_ID: 'TTEAM',
    SLACK_AUTOFIX_BOT_USER_ID: 'UBOT',
    SLACK_AUTOFIX_ALLOWED_USERS: 'UALLOWED',
    SLACK_AUTOFIX_ALLOWED_CHANNELS: 'CALLOWED',
    OMP_GATEWAY_TOKEN: 'local-gateway-bearer-at-least-32-characters',
  };
  const queue = new AutofixQueue({ storage }, env);
  env.AUTOFIX_QUEUE = {
    getByName(name) {
      assert.equal(name, 'bcsdlab/bcsd_united');
      return queue;
    },
  };
  const publications = [];
  const modelBodies = [];
  env.OMP_GATEWAY = {
    async fetch(url, options) {
      assert.equal(url, 'http://omp-gateway/v1/messages');
      const body = JSON.parse(options.body);
      modelBodies.push(body);
      if (modelBodies.length === 1)
        return Response.json({
          type: 'message',
          model: 'claude-opus-5-5',
          content: [
            { type: 'tool_use', id: 'read-request', name: 'Read', input: { path: 'request-input/request.json' } },
          ],
          stop_reason: 'tool_use',
        });
      assert.match(JSON.stringify(body.messages), /게시글 사진/);
      return Response.json({
        type: 'message',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '게시글 사진 표시와 회귀 테스트를 수정했습니다.' }],
        stop_reason: 'end_turn',
      });
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = url instanceof Request ? url.url : String(url);
    if (href.startsWith('https://automation.example/')) return worker.fetch(new Request(url, options), env);
    assert.ok(href.startsWith('https://api.github.com/'), `Unexpected outbound request: ${href}`);
    if (href.endsWith('/access_tokens')) {
      const body = JSON.parse(options.body);
      return Response.json({
        token: 'local-scoped-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repositories: [{ full_name: 'BCSDLab/BCSD_united' }],
      });
    }
    if (href === 'https://api.github.com/repos/BCSDLab/BCSD_united')
      return Response.json({ default_branch: 'develop', owner: { login: 'BCSDLab' } });
    if (href.endsWith('/commits/develop'))
      return Response.json({ sha: baseSha, commit: { tree: { sha: 'b'.repeat(40) } } });
    if (href.includes('/pulls?')) return Response.json([]);
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      publications.push({ href, body });
      if (href.endsWith('/pulls')) return Response.json({ html_url: 'https://github.com/BCSDLab/BCSD_united/pull/42' });
      return Response.json({ sha: 'c'.repeat(40) });
    }
    throw new Error(`Unexpected GitHub request: ${href}`);
  });
  async function executor(path, body) {
    return worker.fetch(
      new Request(`https://automation.example${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AUTOFIX_EXECUTOR_TOKEN}`,
          'X-Executor-Id': 'koin-rocky-umpc',
        },
        body: JSON.stringify({ version: 1, executorId: 'koin-rocky-umpc', ...body }),
      }),
      env,
    );
  }
  return { env, queue, db, publications, modelBodies, executor };
}

test('mentions/questions do not authorize execution; only explicit modification requests do', () => {
  assert.equal(requestText('<@UBOT> 안녕', 'UBOT'), null);
  assert.equal(requestText('<@UBOT> 사진 오류 고칠 수 있어?', 'UBOT'), null);
  assert.equal(requestText('수정요청 <@UBOT> 사진 표시를 고쳐줘', 'UBOT'), null);
  assert.equal(requestText('<@OTHER> 수정요청 사진을 수정해줘', 'UBOT'), null);
  assert.equal(requestText('<@UBOT> 수정요청 사진 표시를 수정해줘', 'UBOT'), '사진 표시를 수정해줘');
  assert.deepEqual(REQUEST_SCOPE, executorScope);
  assert.deepEqual(REQUEST_CHECKS, executorChecks);
});

test('signed Slack request uses durable dedup, executor request prompt and independently verified develop PR publication', async (t) => {
  const h = harness(t);
  const ingress = signed();
  let receipt;
  await forwardAutofixMention(
    {
      fetch: async (request) => {
        const response = await worker.fetch(request, h.env);
        assert.equal(response.status, 200);
        receipt = await response.clone().json();
        return response;
      },
    },
    await ingress.text(),
    ingress.headers.get('x-slack-signature'),
    ingress.headers.get('x-slack-request-timestamp'),
  );
  assert.equal(receipt.status, 'queued');
  assert.equal((await (await worker.fetch(signed(), h.env)).json()).status, 'duplicate');
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 1);
  const claimed = await h.executor('/executor/claim', { claimNonce: 'f'.repeat(64) });
  assert.equal(claimed.status, 200);
  const claim = parseClaim(await claimed.json());
  assert.equal(claim.job.mode, 'request');
  assert.equal(claim.job.baseBranch, 'develop');
  assert.equal(claim.job.targetBranch, 'develop');
  assert.deepEqual(claim.job.changedFiles, REQUEST_SCOPE);
  const root = await mkdtemp(join(tmpdir(), 'slack-autofix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'request-input'));
  await writeFile(join(root, 'request-input/request.json'), JSON.stringify({ text: claim.job.identity.text }));
  await generateAnswer(
    { origin: 'https://automation.example', token: h.env.AUTOFIX_EXECUTOR_TOKEN },
    claim,
    sourceTools(root, requestToolScope(claim.job.changedFiles), new Set()),
    new AbortController().signal,
  );
  assert.equal(h.modelBodies[0].model, 'claude-opus-5-5');
  assert.match(JSON.stringify(h.modelBodies[0].system), /implementation agent/);
  assert.match(JSON.stringify(h.modelBodies[0].system), /untrusted DATA/);
  const manifest = {
    version: 1,
    files: [
      {
        path: 'apps/b-bot/src/photo.ts',
        before: createHash('sha256')
          .update("export const photoUrl = (url: string | null) => url ?? '/images/default-photo.png';\n")
          .digest('hex'),
        content: "export const photoUrl = (url: string | null) => url?.trim() || '/images/default-photo.png';\n",
      },
      {
        path: 'apps/b-bot/test/photo.test.ts',
        before: null,
        content:
          "import { expect, test } from 'vitest';\n" +
          "import { photoUrl } from '../src/photo';\n" +
          "test('blank photo URLs display the default image', () => {\n" +
          "  expect(photoUrl('')).toBe('/images/default-photo.png');\n" +
          "  expect(photoUrl(' https://example.test/photo.png ')).toBe('https://example.test/photo.png');\n" +
          '});\n',
      },
    ],
  };
  const verification = {
    baseSha,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    passedChecks: REQUEST_CHECKS,
  };
  assert.equal(
    (await h.executor(`/executor/jobs/${claim.runId}/verification-start`, { leaseToken: claim.leaseToken })).status,
    200,
  );
  for (const invalid of [
    { manifest, verification: { ...verification, passedChecks: ['pr-head-pinned', ...REQUEST_CHECKS.slice(1)] } },
    {
      manifest,
      verification: {
        ...verification,
        passedChecks: REQUEST_CHECKS.filter((check) => check !== 'request-regression-fails-on-base'),
      },
    },
    { manifest: { ...manifest, files: manifest.files.slice(0, 1) }, verification },
    {
      manifest: {
        ...manifest,
        files: [...manifest.files, { path: 'apps/b-bot/package.json', before: null, content: '{}' }],
      },
      verification,
    },
  ]) {
    const rejected = await h.executor(`/executor/jobs/${claim.runId}/result`, {
      leaseToken: claim.leaseToken,
      outcome: 'verified',
      ...invalid,
    });
    assert.equal(rejected.status, 422, await rejected.clone().text());
    assert.equal(h.publications.length, 0);
  }
  // This contract test supplies a verifier receipt; it does not claim to run the Docker verifier.
  const result = await h.executor(`/executor/jobs/${claim.runId}/result`, {
    leaseToken: claim.leaseToken,
    outcome: 'verified',
    manifest,
    verification,
  });
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { status: 'published', pr: 'https://github.com/BCSDLab/BCSD_united/pull/42' });
  const pull = h.publications.find((item) => item.href.endsWith('/pulls')).body;
  assert.equal(pull.base, 'develop');
  assert.match(pull.head, /^fix\/slack-request-[a-f0-9]{64}$/);
  assert.match(pull.body, /slack-autofix:TTEAM:EvRequest1/);
  assert.doesNotMatch(pull.body, /게시글 사진/);
  const count = h.publications.length;
  assert.equal(
    (
      await h.executor(`/executor/jobs/${claim.runId}/result`, {
        leaseToken: claim.leaseToken,
        outcome: 'verified',
        manifest,
        verification,
      })
    ).status,
    200,
  );
  assert.equal(h.publications.length, count);
});

test('bad signatures, stale replay, unapproved users/channels/teams and absent configuration never enqueue', async (t) => {
  const h = harness(t);
  const badSignature = signed();
  badSignature.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
  assert.equal((await worker.fetch(badSignature, h.env)).status, 401);
  assert.equal((await worker.fetch(signed(event(), String(Math.floor(Date.now() / 1000) - 301)), h.env)).status, 401);
  for (const data of [
    { ...event(), team_id: 'TOTHER' },
    { ...event(), event: { ...event().event, user: 'UOTHER' } },
    { ...event(), event: { ...event().event, channel: 'COTHER' } },
  ])
    assert.equal((await worker.fetch(signed(data), h.env)).status, 403);
  assert.equal((await worker.fetch(signed(), { ...h.env, SLACK_AUTOFIX_ALLOWED_USERS: '' })).status, 403);
  assert.equal((await worker.fetch(signed(), { ...h.env, SLACK_BOT_SIGNING_SECRET: '' })).status, 503);
  assert.equal((await worker.fetch(signed(), { ...h.env, ENVIRONMENT: 'preview' })).status, 503);
  for (const data of [event('<@UBOT> 뭘 할 수 있어?'), { ...event(), event: { ...event().event, bot_id: 'BBOT' } }])
    assert.equal((await (await worker.fetch(signed(data), h.env)).json()).status, 'ignored');
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
  assert.equal(h.publications.length, 0);
});

test('explicit configuration rejections are terminal across the Slack forwarding boundary', async (t) => {
  const h = harness(t);
  const enqueue = t.mock.method(h.queue, 'enqueueRequest');
  for (const override of [
    { SLACK_BOT_SIGNING_SECRET: '' },
    { SLACK_AUTOFIX_BOT_USER_ID: '' },
    { SLACK_AUTOFIX_TEAM_ID: '' },
    { ENVIRONMENT: 'preview' },
    { GITHUB_DISPATCH_APP_ID: '' },
    { SENTRY_PROJECT_APPS: 'invalid-json' },
    { OMP_GATEWAY_TOKEN: '' },
  ]) {
    const ingress = signed();
    await forwardAutofixMention(
      {
        fetch: async (request) => {
          const response = await worker.fetch(request, { ...h.env, ...override });
          assert.equal(response.status, 503);
          assert.equal(response.headers.get('x-slack-autofix-error'), 'not-configured');
          assert.equal(response.headers.get('Retry-After'), null);
          return response;
        },
      },
      await ingress.text(),
      ingress.headers.get('x-slack-signature'),
      ingress.headers.get('x-slack-request-timestamp'),
    );
  }
  assert.equal(enqueue.mock.calls.length, 0);
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
  assert.equal(h.publications.length, 0);
});

test('durable admission outages remain retryable across the Slack forwarding boundary', async (t) => {
  const h = harness(t);
  const enqueue = t.mock.method(h.queue, 'enqueueRequest', async () => {
    throw new Error('durable admission unavailable');
  });
  const ingress = signed();
  await assert.rejects(
    forwardAutofixMention(
      {
        fetch: async (request) => {
          const response = await worker.fetch(request, h.env);
          assert.equal(response.status, 503);
          assert.equal(response.headers.get('x-slack-autofix-error'), null);
          assert.equal(response.headers.get('Retry-After'), '30');
          return response;
        },
      },
      await ingress.text(),
      ingress.headers.get('x-slack-signature'),
      ingress.headers.get('x-slack-request-timestamp'),
    ),
    /intake failed \(503\)/,
  );
  assert.equal(enqueue.mock.calls.length, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
  enqueue.mock.restore();
  assert.equal((await (await worker.fetch(signed(), h.env)).json()).status, 'queued');
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 1);
  assert.equal(h.publications.length, 0);
});

test('invalid UTF-8 is a bad request and never reaches durable admission', async (t) => {
  const h = harness(t);
  const enqueue = t.mock.method(h.queue, 'enqueueRequest');
  const response = await worker.fetch(signedBody(new Uint8Array([0x7b, 0x22, 0xc3, 0x28])), h.env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid UTF-8/);
  assert.equal(response.headers.get('x-slack-autofix-error'), null);
  assert.equal(enqueue.mock.calls.length, 0);
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
  assert.equal(h.publications.length, 0);
});

test('request claims cannot change repository/branch/scope and request model tools cannot touch credentials or automation', async (t) => {
  const h = harness(t);
  await worker.fetch(signed(), h.env);
  const claim = parseClaim(await (await h.executor('/executor/claim', { claimNonce: 'e'.repeat(64) })).json());
  for (const patch of [
    { baseBranch: 'main' },
    { targetBranch: 'main' },
    { repository: 'other' },
    { changedFiles: ['scripts/autofix/'] },
    { branch: 'fix/other' },
  ])
    assert.throws(() => parseClaim({ ...claim, job: { ...claim.job, ...patch } }));
  const scope = requestToolScope(REQUEST_SCOPE);
  assert.equal(scope.readable('request-input/request.json'), true);
  for (const name of [
    'apps/b-bot/.dev.vars',
    'apps/b-bot/package.json',
    'apps/b-bot/wrangler.jsonc',
    'apps/error-automation/src/index.ts',
    'scripts/autofix/executor.mjs',
  ])
    assert.equal(scope.writable(name), false, name);
  assert.equal(scope.readable('apps/b-bot/.dev.vars'), false);
});

test('request regressions use existing discovered test locations and retain source/test/docs policy', () => {
  const scope = requestToolScope(REQUEST_SCOPE);
  for (const path of [
    'apps/web/test/photo.test.ts',
    'apps/api/tests/photo.test.ts',
    'apps/api/src/photo.test.ts',
    'apps/b-bot/test/slack/photo.test.ts',
    'packages/b-bot-ai/test/photo.test.ts',
  ]) {
    assert.equal(scope.writable(path), true, path);
    assert.equal(requestRegressionPath(path), true, path);
    assert.equal(executorRegressionPath(path), true, path);
  }
  for (const path of [
    'apps/web/src/photo.test.ts',
    'apps/web/test/nested/photo.test.ts',
    'apps/b-bot/src/photo.test.ts',
    'packages/b-bot-database/test/photo.test.ts',
  ]) {
    assert.equal(requestRegressionPath(path), false, path);
    assert.equal(executorRegressionPath(path), false, path);
  }
  for (const path of [
    'apps/b-bot/src/photo.ts',
    'packages/telemetry/src/photo.ts',
    'apps/b-bot/test/photo.ts',
    'apps/b-bot/README.md',
  ]) {
    assert.equal(scope.writable(path), true, path);
    assert.equal(requestSourcePath(path), executorSourcePath(path), path);
  }
});
