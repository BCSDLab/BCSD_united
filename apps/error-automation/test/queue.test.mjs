import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { registerHooks } from 'node:module';
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
const { AutofixQueue } = await import('../src/queue.ts');
const identity = {
  source: 'sentry',
  sourceId: '123',
  project: 'koin-united-prod',
  app: 'web',
  scope: { organization: 'bcsd' },
};
const key = 'sentry/bcsd/koin-united-prod/123';
const base = 'a'.repeat(40),
  tree = 'b'.repeat(40);
const marker = '<!-- error-autofix:sentry:bcsd:koin-united-prod:123 -->';
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
function harness(t) {
  const db = new DatabaseSync(':memory:'),
    alarms = [];
  const storage = {
    sql: {
      exec(query, ...params) {
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    setAlarm: async (time) => alarms.push(time),
    sync: async () => {},
  };
  const env = {
    ENVIRONMENT: 'production',
    SENTRY_CLIENT_SECRET: 'local-sentry-secret',
    SENTRY_READ_TOKEN: 'local-read-secret',
    SENTRY_ORGANIZATION: 'bcsd',
    SENTRY_PROJECT_APPS: '{"koin-united-prod":"web"}',
    SENTRY_PROJECT_HOSTS: '{"koin-united-prod":["koreatech.in"]}',
    ERROR_PROJECT_DOMAINS: '{"sentry:koin-united-prod":"공통"}',
    CLOUDFLARE_SOURCES: '[]',
    CLOUDFLARE_WEBHOOK_SECRET: 'local-cloudflare-secret-32-characters',
    DIAGNOSTICS_READ_TOKEN: 'local-diagnostic-secret-32-characters',
    GITHUB_OWNER: 'BCSDLab',
    GITHUB_REPOSITORY: 'BCSD_united',
    GITHUB_DISPATCH_APP_ID: '5522353',
    GITHUB_DISPATCH_APP_PRIVATE_KEY: appKey,
    GITHUB_DISPATCH_INSTALLATION_ID: '176455083',
    AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc',
    AUTOFIX_EXECUTOR_TOKEN: 'local-dedicated-executor-secret-32-characters',
    ANTHROPIC_API_KEY: 'local-test-only-anthropic-key',
    ERROR_ISSUES: {
      idFromName: (name) => name,
      get() {
        return {
          fetch: async () =>
            Response.json({
              version: 1,
              identity,
              capturedAt: new Date().toISOString(),
              summary: 'bug',
              details: { resource: 'issue', action: 'created' },
            }),
        };
      },
    },
  };
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (options.method === 'POST') writes.push(href);
    if (href.endsWith('/access_tokens')) {
      const { permissions, repositories } = JSON.parse(options.body);
      assert.deepEqual(repositories, ['BCSD_united']);
      return Response.json({
        token: 'test-only-repo-scoped-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions,
        repositories: [{ full_name: 'BCSDLab/BCSD_united' }],
      });
    }
    if (href === 'https://api.github.com/repos/BCSDLab/BCSD_united')
      return Response.json({ default_branch: 'develop', owner: { login: 'BCSDLab' } });
    if (href.endsWith('/commits/develop')) return Response.json({ sha: base, commit: { tree: { sha: tree } } });
    if (href.includes('/issues?'))
      return Response.json([{ number: 9, body: marker, user: { login: 'bcsd-united-error-publisher[bot]' } }]);
    if (href.includes('/pulls?')) return Response.json([]);
    if (href.endsWith('/issues/9/comments') && options.method === 'POST') return Response.json({ id: 9001 });
    if (href === 'https://api.anthropic.com/v1/messages') {
      assert.equal(options.headers['x-api-key'], env.ANTHROPIC_API_KEY);
      assert.deepEqual(
        JSON.parse(options.body).tools.map((tool) => tool.name),
        ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      );
      return Response.json({
        type: 'message',
        model: 'claude-fable-5-1',
        content: [{ type: 'text', text: 'investigating' }],
        stop_reason: 'end_turn',
      });
    }
    if (href === 'https://sentry.io/api/0/organizations/bcsd/issues/123/')
      return Response.json({ id: 123, project: { slug: 'koin-united-prod' }, title: 'bug', culprit: 'src/bug.ts' });
    if (href.endsWith('/events/latest/'))
      return Response.json({
        platform: 'javascript',
        sdk: { name: 'sentry.javascript.react' },
        groupID: 123,
        eventID: 'c'.repeat(32),
        entries: [
          { type: 'request', data: { url: 'https://koreatech.in/campus' } },
          {
            type: 'exception',
            data: {
              values: [
                {
                  type: 'TypeError',
                  value: 'bug',
                  stacktrace: { frames: [{ filename: 'src/bug.ts', lineNo: 42, inApp: true }] },
                },
              ],
            },
          },
        ],
      });
    throw new Error(`Unexpected trusted request ${href}`);
  });
  t.after(() => db.close());
  return { queue: new AutofixQueue({ storage }, env), db, writes, alarms };
}

test('queue persists immutable fixed job, issues one random lease, and prevents parallel claim', async (t) => {
  const h = harness(t);
  assert.equal(await h.queue.enqueue(identity, key), 'queued');
  assert.equal(await h.queue.enqueue(identity, key), 'duplicate');
  const claim = await h.queue.claim('f'.repeat(64));
  assert.equal(claim.version, 1);
  assert.match(claim.runId, /^autofix-[a-f0-9]{64}$/);
  assert.match(claim.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(claim.job.baseSha, base);
  assert.equal(claim.job.issueNumber, 9);
  assert.equal(claim.job.context.route, '/campus');
  assert.deepEqual(await h.queue.claim('f'.repeat(64)), claim);
  assert.equal(await h.queue.claim('e'.repeat(64)), null);
  assert.equal(h.db.prepare('SELECT lease_hash FROM jobs').get().lease_hash === claim.leaseToken, false);
  const heartbeat = await h.queue.heartbeat(claim.runId, claim.leaseToken);
  assert.equal(heartbeat.deadlineAt, claim.deadlineAt);
  assert.ok(heartbeat.leaseExpiresAt <= claim.deadlineAt);
  await assert.rejects(h.queue.heartbeat(claim.runId, '0'.repeat(64)), /lease/);
  assert.equal(
    h.writes.some((url) => url.includes('/git/')),
    false,
  );
});

test('claimed model assertions are never treated as verification proof; expired lease never reassigned', async (t) => {
  const h = harness(t);
  await h.queue.enqueue(identity, key);
  const claim = await h.queue.claim('f'.repeat(64));
  await assert.rejects(h.queue.verificationStart(claim.runId, claim.leaseToken), /model generation/);
  const request = {
    model: 'claude-fable-5-1',
    maxTokens: 4096,
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    messages: [{ role: 'user', content: 'Find observed bug' }],
  };
  await h.queue.model(claim.runId, claim.leaseToken, request);
  assert.deepEqual(await h.queue.verificationStart(claim.runId, claim.leaseToken), { status: 'verifying' });
  await assert.rejects(h.queue.model(claim.runId, claim.leaseToken, request), /lease/);
  const manifest = {
    version: 1,
    files: [
      { path: 'apps/web/src/bug.ts', before: 'd'.repeat(64), content: 'export const fixed = true;' },
      {
        path: 'tests/autofix/bug.test.mjs',
        before: null,
        content: 'import assert from "node:assert/strict"; assert.ok(true);',
      },
    ],
  };
  const bogus = {
    version: 1,
    executorId: 'koin-rocky-umpc',
    leaseToken: claim.leaseToken,
    outcome: 'verified',
    manifest,
    verification: { baseSha: base, manifestSha256: '0'.repeat(64), passedChecks: ['model-says-passed'] },
  };
  await assert.rejects(h.queue.result(claim.runId, bogus), /verification|hash|provenance/i);
  assert.equal(h.db.prepare('SELECT status FROM jobs').get().status, 'verifying');
  h.db.prepare('UPDATE jobs SET lease_expires = ?').run(Date.now() - 1);
  await h.queue.alarm();
  assert.equal(h.db.prepare('SELECT status FROM jobs').get().status, 'failed');
  assert.equal(await h.queue.claim('f'.repeat(64)), null);
  assert.equal(
    h.writes.some((url) => url.includes('/git/')),
    false,
  );
});

test('completed no-fix receipt is idempotent for same lease and never creates a PR', async (t) => {
  const h = harness(t);
  await h.queue.enqueue(identity, key);
  const claim = await h.queue.claim('f'.repeat(64));
  const result = {
    version: 1,
    executorId: 'koin-rocky-umpc',
    leaseToken: claim.leaseToken,
    outcome: 'no-fix',
    reason: 'No safe causal evidence',
  };
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded' });
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded' });
  assert.equal(h.writes.filter((url) => url.endsWith('/issues/9/comments')).length, 1);
  assert.equal(
    h.writes.some((url) => url.endsWith('/pulls') || url.includes('/git/')),
    false,
  );
});
