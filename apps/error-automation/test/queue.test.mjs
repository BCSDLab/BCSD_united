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
const { parseErrorMonitorSnapshot } = await import('../../../packages/telemetry/src/monitor.ts');
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
    ERROR_SOURCE_BRANCHES: '{"sentry:koin-united-prod":"main"}',
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
    OMP_GATEWAY: { fetch: (...args) => globalThis.fetch(...args) },
    OMP_GATEWAY_TOKEN: 'local-gateway-bearer-0123456789abcdef',
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
    if (href.endsWith('/commits/main')) return Response.json({ sha: base, commit: { tree: { sha: tree } } });
    if (href.includes('/pulls?')) return Response.json([]);
    if (href === 'http://omp-gateway/v1/messages') {
      assert.equal(options.headers.Authorization, `Bearer ${env.OMP_GATEWAY_TOKEN}`);
      assert.deepEqual(
        JSON.parse(options.body).tools.map((tool) => tool.name),
        ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      );
      return Response.json({
        type: 'message',
        model: 'claude-sonnet-5-5',
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
  assert.equal(claim.job.baseBranch, 'main');
  assert.equal(claim.job.targetBranch, 'develop');
  assert.equal(Object.hasOwn(claim.job, 'issueNumber'), false);
  assert.equal(claim.job.context.route, '/campus');
  assert.equal(Number.isSafeInteger(claim.leaseExpiresAt), true);
  assert.ok(claim.leaseExpiresAt > Date.now());
  assert.ok(claim.leaseExpiresAt <= claim.deadlineAt);
  assert.equal(claim.leaseExpiresAt, h.db.prepare('SELECT lease_expires FROM jobs').get().lease_expires);
  const legacy = { ...claim.job };
  delete legacy.targetBranch;
  h.db.prepare('UPDATE jobs SET prepared = ?').run(JSON.stringify(legacy));
  assert.equal((await h.queue.claim('f'.repeat(64))).job.targetBranch, 'develop');
  assert.equal(JSON.parse(h.db.prepare('SELECT prepared FROM jobs').get().prepared).targetBranch, undefined);
  assert.deepEqual(await h.queue.claim('f'.repeat(64)), claim);
  assert.equal(await h.queue.claim('e'.repeat(64)), null);
  assert.equal(h.db.prepare('SELECT lease_hash FROM jobs').get().lease_hash === claim.leaseToken, false);
  // Resumed claim reports the actual stored expiry, even after the lease was shortened server-side.
  const shortened = Date.now() + 30_000;
  h.db.prepare('UPDATE jobs SET lease_expires = ?').run(shortened);
  assert.deepEqual(await h.queue.claim('f'.repeat(64)), { ...claim, leaseExpiresAt: shortened });
  const heartbeat = await h.queue.heartbeat(claim.runId, claim.leaseToken);
  assert.equal(heartbeat.deadlineAt, claim.deadlineAt);
  assert.ok(heartbeat.leaseExpiresAt > shortened);
  assert.ok(heartbeat.leaseExpiresAt <= claim.deadlineAt);
  assert.equal(heartbeat.leaseExpiresAt, h.db.prepare('SELECT lease_expires FROM jobs').get().lease_expires);
  // Heartbeat never extends an expired lease, and the resume handshake reports nothing for it.
  h.db.prepare('UPDATE jobs SET lease_expires = ?').run(Date.now() - 1);
  await assert.rejects(h.queue.heartbeat(claim.runId, claim.leaseToken), /lease/);
  assert.equal(h.db.prepare('SELECT lease_expires FROM jobs').get().lease_expires < Date.now(), true);
  assert.equal(await h.queue.claim('f'.repeat(64)), null);
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
    model: 'claude-sonnet-5-5',
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

test('wont-fix persists a private reason across restart without GitHub writes or redelivery', async (t) => {
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
  const writesBefore = h.writes.length;
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded', outcome: 'wont-fix' });
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded', outcome: 'wont-fix' });
  assert.equal(h.writes.length, writesBefore);
  const status = await h.queue.errorStatus(key);
  assert.deepEqual(status, {
    runId: claim.runId,
    status: 'completed',
    outcome: 'wont-fix',
    reason: 'No safe causal evidence',
    prUrl: null,
  });
  const restarted = new AutofixQueue(h.queue.ctx, h.queue.env);
  assert.deepEqual(await restarted.errorStatus(key), status);
  assert.equal(await restarted.enqueue(identity, key), 'duplicate');
  assert.equal(await restarted.claim('e'.repeat(64)), null);
  await assert.rejects(restarted.result(claim.runId, { ...result, outcome: 'failed' }), /conflicts/);
  assert.equal(
    h.writes.some((url) => url.endsWith('/pulls') || url.includes('/git/')),
    false,
  );
});

test('executor failure remains failed, redacts its reason, and never publishes an issue', async (t) => {
  const h = harness(t);
  await h.queue.enqueue(identity, key);
  const claim = await h.queue.claim('f'.repeat(64));
  const writesBefore = h.writes.length;
  const result = {
    version: 1,
    executorId: 'koin-rocky-umpc',
    leaseToken: claim.leaseToken,
    outcome: 'failed',
    reason: `Build failed ${h.queue.env.AUTOFIX_EXECUTOR_TOKEN} person@example.com`,
  };
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded', outcome: 'failed' });
  assert.deepEqual(await h.queue.result(claim.runId, result), { status: 'recorded', outcome: 'failed' });
  assert.deepEqual(await h.queue.errorStatus(key), {
    runId: claim.runId,
    status: 'failed',
    outcome: 'failed',
    reason: 'Build failed [REDACTED] [EMAIL]',
    prUrl: null,
  });
  assert.equal(h.writes.length, writesBefore);
  assert.equal(await h.queue.errorStatus('github-pr/42'), null);
  assert.equal(await h.queue.errorStatus('sentry/bcsd/koin-united-prod/999'), null);
});

test('issue-free schema migration preserves prior identity tombstones and PR receipts', async (t) => {
  const h = harness(t);
  await h.queue.enqueue(identity, key);
  h.db.exec('ALTER TABLE jobs DROP COLUMN reason; ALTER TABLE jobs ADD COLUMN issue_number INTEGER');
  h.db
    .prepare("UPDATE jobs SET status = 'completed', outcome = 'published', issue_number = 41, pr_url = ?")
    .run('https://github.com/BCSDLab/BCSD_united/pull/99');
  const restarted = new AutofixQueue(h.queue.ctx, h.queue.env);
  assert.equal(await restarted.enqueue(identity, key), 'duplicate');
  assert.equal(await restarted.claim('e'.repeat(64)), null);
  const receipt = await restarted.errorStatus(key);
  assert.equal(receipt.outcome, 'published');
  assert.equal(receipt.prUrl, 'https://github.com/BCSDLab/BCSD_united/pull/99');
  assert.equal(receipt.reason, null);
});

test('monitor snapshot counts registered identities in 24h without exposing job payloads or changing state', async (t) => {
  const h = harness(t);
  const now = Date.now();
  const start = now - 24 * 60 * 60_000;
  const secret = 'private-source-id-and-diagnostic';
  const insert = h.db.prepare(
    'INSERT INTO jobs (run_id, identity_key, identity, status, enqueued_at, reason, prepared) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const add = (digit, source, app, workerName, registeredAt, status = 'queued') => {
    const rowIdentity = {
      source,
      sourceId: `${secret}-${digit}`,
      project: workerName ?? 'koin-united-prod',
      app,
      scope:
        source === 'cloudflare' ? { accountId: 'private', policyId: 'private', workerName } : { organization: 'bcsd' },
    };
    insert.run(
      `autofix-${digit.toString(16).padStart(64, '0')}`,
      `${source}/${digit}`,
      JSON.stringify(rowIdentity),
      status,
      registeredAt,
      `private-reason-${digit}`,
      `private-prepared-${digit}`,
    );
  };
  assert.equal(await h.queue.enqueue(identity, key), 'queued');
  assert.equal(await h.queue.enqueue(identity, key), 'duplicate');
  h.db.prepare('UPDATE jobs SET enqueued_at = ? WHERE identity_key = ?').run(start, key);
  for (let i = 1; i <= 12; i++) add(i, 'sentry', 'web', null, now - i * 1000, i === 1 ? 'failed' : 'completed');
  add(13, 'cloudflare', 'api', 'koin-web-api', now - 500, 'verifying');
  add(14, 'cloudflare', 'web', 'koin-web', now - 700, 'leased');
  add(15, 'cloudflare', 'api', 'koin-api', now - 300);
  add(16, 'cloudflare', 'web', 'koin-api', now - 200);
  add(17, 'sentry', 'web', null, start - 1);
  add(18, 'cloudflare', 'web', 'koin-web', now + 1);
  insert.run(
    `autofix-${'f'.repeat(64)}`,
    'github-pr/42',
    JSON.stringify({ source: 'github-pr', pullNumber: 42 }),
    'queued',
    now,
    'private-pr-reason',
    'private-pr-payload',
  );
  const before = h.db.prepare('SELECT * FROM jobs ORDER BY run_id').all();
  const changes = h.db.prepare('SELECT total_changes() AS count').get().count;
  const snapshot = h.queue.monitorSnapshot(now);
  assert.deepEqual(snapshot.sources, {
    sentry: { count: 13, latestAt: now - 1000 },
    cloudflare: { count: 2, latestAt: now - 500 },
  });
  assert.equal(snapshot.checkedAt, now);
  assert.equal(snapshot.windowStart, start);
  assert.equal(snapshot.scope, 'ingress-only');
  assert.equal(snapshot.worker, 'responding');
  assert.equal(snapshot.recent.length, 10);
  assert.deepEqual(
    snapshot.recent.slice(0, 3).map(({ source, registeredAt, status }) => [source, registeredAt, status]),
    [
      ['cloudflare', now - 500, 'verifying'],
      ['cloudflare', now - 700, 'leased'],
      ['sentry', now - 1000, 'failed'],
    ],
  );
  assert.equal(
    snapshot.recent.every(
      (item, index) =>
        item.registeredAt >= start && (!index || item.registeredAt <= snapshot.recent[index - 1].registeredAt),
    ),
    true,
  );
  assert.equal(
    snapshot.recent.every(({ id }) => /^autofix-[a-f0-9]{64}$/.test(id)),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private|sourceId|identity_key|prepared|reason|pr_url|koin-api|github-pr/,
  );
  assert.deepEqual(h.db.prepare('SELECT * FROM jobs ORDER BY run_id').all(), before);
  assert.equal(h.db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.deepEqual(h.alarms, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(new AutofixQueue(h.queue.ctx, h.queue.env).monitorSnapshot(now), snapshot);
});

test('monitor snapshot aggregates a source absent from recent ten and rejects invalid older rows', (t) => {
  const h = harness(t);
  const now = Date.now();
  const insert = h.db.prepare(
    'INSERT INTO jobs (run_id, identity_key, identity, status, enqueued_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= 12; i++) {
    insert.run(
      `autofix-${i.toString(16).padStart(64, '0')}`,
      `sentry/${i}`,
      JSON.stringify({ ...identity, sourceId: String(i) }),
      'queued',
      now - i * 1000,
    );
  }
  const cloudflareIdentity = {
    source: 'cloudflare',
    sourceId: 'older',
    project: 'koin-web',
    app: 'web',
    scope: { accountId: 'account', policyId: 'policy', workerName: 'koin-web' },
  };
  insert.run(
    `autofix-${'d'.repeat(64)}`,
    'cloudflare/older',
    JSON.stringify(cloudflareIdentity),
    'failed',
    now - 20_000,
  );
  const snapshot = h.queue.monitorSnapshot(now);
  assert.deepEqual(snapshot.sources, {
    sentry: { count: 12, latestAt: now - 1000 },
    cloudflare: { count: 1, latestAt: now - 20_000 },
  });
  assert.equal(snapshot.recent.length, 10);
  assert.equal(
    snapshot.recent.every((entry) => entry.source === 'sentry'),
    true,
  );

  insert.run(
    `autofix-${'e'.repeat(64)}`,
    'cloudflare/invalid',
    JSON.stringify({ ...cloudflareIdentity, scope: { accountId: 'account', policyId: 'policy' } }),
    'queued',
    now - 30_000,
  );
  assert.throws(() => h.queue.monitorSnapshot(now), /Invalid monitor identity/);
  h.db.prepare('UPDATE jobs SET identity = ? WHERE identity_key = ?').run('{not json', 'cloudflare/invalid');
  assert.throws(() => h.queue.monitorSnapshot(now));
});

test('monitor snapshot reports observed empty windows, not stale jobs or malformed identities', (t) => {
  const h = harness(t);
  const now = Date.now();
  assert.deepEqual(h.queue.monitorSnapshot(now).sources, {
    sentry: { count: 0, latestAt: null },
    cloudflare: { count: 0, latestAt: null },
  });
  h.db
    .prepare('INSERT INTO jobs (run_id, identity_key, identity, status, enqueued_at) VALUES (?, ?, ?, ?, ?)')
    .run(`autofix-${'a'.repeat(64)}`, 'sentry/bad', '{not json', 'queued', now);
  assert.throws(() => h.queue.monitorSnapshot(now));
  h.db.prepare('UPDATE jobs SET identity = ?').run(
    JSON.stringify({
      source: 'cloudflare',
      sourceId: 'id',
      project: 'koin-web',
      app: 'web',
      scope: { accountId: 'account', policyId: 'policy' },
    }),
  );
  assert.throws(() => h.queue.monitorSnapshot(now), /Invalid monitor identity/);
  assert.throws(() => h.queue.monitorSnapshot(NaN), /Invalid monitor time/);
});

test('shared monitor parser accepts fresh ingress snapshots and rejects stale, unsafe, or inconsistent payloads', () => {
  const now = Date.now();
  const snapshot = {
    version: 1,
    scope: 'ingress-only',
    checkedAt: now,
    windowStart: now - 24 * 60 * 60_000,
    worker: 'responding',
    sources: {
      sentry: { count: 1, latestAt: now - 10 },
      cloudflare: { count: 0, latestAt: null },
    },
    recent: [
      { id: `autofix-${'a'.repeat(64)}`, source: 'sentry', app: 'web', registeredAt: now - 10, status: 'queued' },
    ],
  };
  assert.deepEqual(parseErrorMonitorSnapshot(snapshot, now), snapshot);
  const shift = (offset) => ({
    ...snapshot,
    checkedAt: now + offset,
    windowStart: now + offset - 24 * 60 * 60_000,
    sources: { ...snapshot.sources, sentry: { count: 1, latestAt: now + offset - 10 } },
    recent: [{ ...snapshot.recent[0], registeredAt: now + offset - 10 }],
  });
  assert.deepEqual(parseErrorMonitorSnapshot(shift(-120_000), now), shift(-120_000));
  assert.deepEqual(parseErrorMonitorSnapshot(shift(60_000), now), shift(60_000));
  assert.equal(parseErrorMonitorSnapshot(shift(-120_001), now), null);
  assert.equal(parseErrorMonitorSnapshot(shift(60_001), now), null);
  assert.equal(parseErrorMonitorSnapshot(snapshot, NaN), null);
  const invalid = [
    { ...snapshot, version: 2 },
    { ...snapshot, scope: 'executor-healthy' },
    { ...snapshot, worker: 'healthy' },
    { ...snapshot, checkedAt: Infinity },
    { ...snapshot, windowStart: snapshot.windowStart - 1 },
    { ...snapshot, diagnostic: 'secret' },
    { ...snapshot, sources: { ...snapshot.sources, sentry: { count: -1, latestAt: now - 10 } } },
    { ...snapshot, sources: { ...snapshot.sources, sentry: { count: 1.5, latestAt: now - 10 } } },
    { ...snapshot, sources: { ...snapshot.sources, sentry: { count: 1, latestAt: null } } },
    { ...snapshot, sources: { ...snapshot.sources, sentry: { count: 1, latestAt: now + 1 } } },
    { ...snapshot, sources: { ...snapshot.sources, cloudflare: { count: 0, latestAt: null, token: 'secret' } } },
    { ...snapshot, sources: { ...snapshot.sources, cloudflare: { count: 1, latestAt: null } } },
    { ...snapshot, recent: [{ ...snapshot.recent[0], status: 'unknown' }] },
    { ...snapshot, recent: [{ ...snapshot.recent[0], sourceId: 'secret' }] },
    { ...snapshot, recent: [{ ...snapshot.recent[0], id: 'source-id' }] },
    { ...snapshot, recent: [{ ...snapshot.recent[0], registeredAt: snapshot.windowStart - 1 }] },
    { ...snapshot, recent: [{ ...snapshot.recent[0], registeredAt: now + 1 }] },
    { ...snapshot, recent: [{ ...snapshot.recent[0], app: 'api' }] },
    { ...snapshot, recent: Array(11).fill(snapshot.recent[0]) },
    {
      ...snapshot,
      recent: [snapshot.recent[0], { ...snapshot.recent[0], id: `autofix-${'b'.repeat(64)}`, registeredAt: now - 1 }],
    },
  ];
  for (const candidate of invalid) assert.equal(parseErrorMonitorSnapshot(candidate, now), null);
});
