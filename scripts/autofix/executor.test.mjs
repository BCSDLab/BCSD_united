import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPullRequest,
  keepLease,
  parseAssistantBlocks,
  parseClaim,
  parseRetryAfterSeconds,
  requestModel,
} from './executor.mjs';

const branchFor = (identity) => {
  const key =
    identity.source === 'sentry'
      ? `sentry/${identity.scope.organization}/${identity.project}/${identity.sourceId}`
      : `cloudflare/${identity.scope.accountId}/${identity.scope.policyId}/${identity.project}/${identity.sourceId}`;
  return `fix/${identity.source}-${createHash('sha256').update(key).digest('hex')}`;
};

const valid = () => ({
  version: 1,
  runId: `autofix-${'a'.repeat(64)}`,
  leaseToken: 'b'.repeat(64),
  attempt: 1,
  deadlineAt: Date.now() + 60_000,
  leaseExpiresAt: Date.now() + 30_000,
  job: {
    identity: {
      source: 'sentry',
      sourceId: '123',
      project: 'koin-united-prod',
      app: 'web',
      scope: { organization: 'bcsd' },
    },
    owner: 'BCSDLab',
    repository: 'BCSD_united',
    baseSha: 'c'.repeat(40),
    baseBranch: 'develop',
    branch: branchFor({
      source: 'sentry',
      sourceId: '123',
      project: 'koin-united-prod',
      app: 'web',
      scope: { organization: 'bcsd' },
    }),
    domain: '공통',
    diagnostics: { summary: 'redacted' },
    context: { app: 'web', route: '/', requestMethod: 'GET' },
  },
});

test('Rocky executor accepts issue-free jobs with fixed provider identity and lease', () => {
  const claim = valid();
  assert.equal(parseClaim(claim).runId, claim.runId);
  // A resumed claim reports the stored expiry, which may be close.
  assert.equal(parseClaim({ ...claim, leaseExpiresAt: Date.now() + 1_000 }).runId, claim.runId);
  const cloudflare = {
    source: 'cloudflare',
    sourceId: 'a'.repeat(32),
    project: 'koin-api',
    app: 'api',
    scope: { accountId: 'b'.repeat(32), policyId: 'c'.repeat(32), workerName: 'koin-api' },
  };
  const cfClaim = {
    ...claim,
    job: {
      ...claim.job,
      identity: cloudflare,
      branch: branchFor(cloudflare),
      context: { app: 'api', route: '/shops/categories', requestMethod: 'GET' },
    },
  };
  assert.equal(parseClaim(cfClaim).runId, claim.runId);
  for (const patch of [
    { runId: 'arbitrary-job' },
    { leaseToken: 'not-a-lease' },
    { deadlineAt: 'tomorrow' },
    { deadlineAt: Date.now() - 1 },
    { deadlineAt: Date.now() + 91 * 60_000 },
    { leaseExpiresAt: undefined },
    { leaseExpiresAt: 'soon' },
    { leaseExpiresAt: Date.now() - 1 },
    { leaseExpiresAt: claim.deadlineAt + 1 },
    { job: { ...claim.job, repository: 'other' } },
    { job: { ...claim.job, issueNumber: 7 } },
    { job: { ...claim.job, branch: 'fix/#7/sentry-123' } },
    { job: { ...claim.job, baseBranch: 'main' } },
    { job: { ...claim.job, domain: 'unknown' } },
    { job: { ...claim.job, identity: { ...claim.job.identity, sourceId: '00123' } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, sourceId: 123 } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, source: 'unknown' } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, app: 'api' } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, scope: { organization: 'other' } } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, scope: { organization: 'BCSD' } } } },
    { job: { ...claim.job, identity: { ...claim.job.identity, injected: true } } },
    { job: { ...claim.job, context: { ...claim.job.context, route: '//other' } } },
    { job: { ...claim.job, context: { ...claim.job.context, requestMethod: 'POST' } } },
    { job: { ...claim.job, context: { ...claim.job.context, injected: true } } },
    { job: { ...claim.job, diagnostics: [] } },
  ])
    assert.throws(() => parseClaim({ ...claim, ...patch }), undefined, JSON.stringify(patch).slice(0, 80));
  for (const identity of [
    { ...cloudflare, sourceId: 'A'.repeat(32) },
    { ...cloudflare, project: 'other' },
    { ...cloudflare, app: 'web' },
    { ...cloudflare, scope: { ...cloudflare.scope, policyId: 'A'.repeat(32) } },
    { ...cloudflare, scope: { ...cloudflare.scope, workerName: 'other' } },
    { ...cloudflare, scope: { ...cloudflare.scope, accountId: null } },
  ])
    assert.throws(() => parseClaim({ ...cfClaim, job: { ...cfClaim.job, identity } }));
  const malformed = { ...cloudflare, sourceId: 'A'.repeat(32) };
  assert.throws(() =>
    parseClaim({ ...cfClaim, job: { ...cfClaim.job, identity: malformed, branch: branchFor(malformed) } }),
  );
});

test('Fable signed thinking stays opaque while only declared file tools are executable', () => {
  const thinking = { type: 'thinking', thinking: 'private reasoning fixture', signature: 'opaque-signature' };
  const redacted = { type: 'redacted_thinking', data: 'encrypted-fixture' };
  const call = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { path: 'apps/web/src/a.ts' },
    caller: { type: 'direct' },
    toolset_name: null,
  };
  const blocks = [thinking, redacted, { type: 'text', text: 'Public result', citations: null }, call];
  const parsed = parseAssistantBlocks(blocks);
  assert.equal(parsed.text, 'Public result');
  assert.deepEqual(parsed.calls, [call]);
  assert.equal(JSON.stringify(parsed.blocks), JSON.stringify(blocks));
  for (const bad of [
    { ...thinking, signature: '' },
    { ...thinking, signature: 'x'.repeat(64001) },
    { ...redacted, data: '' },
    { ...call, name: 'Bash' },
    { ...call, caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' } },
    { ...call, toolset_name: 'undeclared' },
    { type: 'text', text: 'Unsupported citation', citations: [{ type: 'web_search_result_location' }] },
    { type: 'server_tool_use', id: 'x', name: 'web_search', input: {} },
  ])
    assert.throws(() => parseAssistantBlocks([bad]));
});

const pullRequest = () => ({
  version: 1,
  runId: `autofix-${'d'.repeat(64)}`,
  leaseToken: 'e'.repeat(64),
  attempt: 1,
  deadlineAt: Date.now() + 60_000,
  leaseExpiresAt: Date.now() + 30_000,
  job: {
    mode: 'pull-request',
    owner: 'BCSDLab',
    repository: 'BCSD_united',
    pullNumber: 9,
    headSha: '1'.repeat(40),
    headTree: '2'.repeat(40),
    headRef: 'chore/8-use-java-api',
    baseBranch: 'develop',
    baseSha: '3'.repeat(40),
    changedFiles: ['apps/web/src/routes/api.$.ts', 'apps/web/wrangler.jsonc', 'README.md'],
    reviewContext: {
      version: 1,
      comments: [
        {
          kind: 'issue-comment',
          author: 'koin-review[bot]',
          createdAt: '2026-11-04T10:00:00Z',
          path: null,
          line: null,
          body: '[APPROVED] please verify the state reset',
        },
      ],
    },
  },
});

test('Rocky executor accepts only the explicit pinned pull-request union member', () => {
  const claim = pullRequest();
  assert.equal(isPullRequest(parseClaim(claim).job), true);
  assert.equal(isPullRequest(parseClaim(valid()).job), false);
  const noContext = pullRequest();
  delete noContext.job.reviewContext;
  assert.equal(parseClaim(noContext).runId, claim.runId);
  for (const patch of [
    { mode: 'error' },
    { mode: 'pull-request', changedFiles: undefined },
    { headSha: 'HEAD' },
    { headTree: 'tree' },
    { baseSha: claim.job.headSha },
    { baseBranch: 'main' },
    { headRef: 'develop' },
    { headRef: 'refs/../heads' },
    { headRef: 'feature/' },
    { pullNumber: 0 },
    { changedFiles: ['../escape.ts'] },
    { changedFiles: ['apps/web/src/a.ts', 'apps/web/src/a.ts'] },
    { changedFiles: Array.from({ length: 501 }, (_, i) => `apps/web/src/${i}.ts`) },
    {
      reviewContext: {
        version: 1,
        comments: [
          { kind: 'command', author: 'x', createdAt: '2026-11-04T10:00:00Z', path: null, line: null, body: 'y' },
        ],
      },
    },
    {
      reviewContext: {
        version: 1,
        comments: [
          { kind: 'review', author: 'x', createdAt: '2026-11-04T10:00:00Z', path: null, line: null, body: 'a\u0000b' },
        ],
      },
    },
    { reviewContext: { version: 1, comments: Array.from({ length: 51 }, () => claim.job.reviewContext.comments[0]) } },
    { reviewContext: { version: 2, comments: [] } },
  ])
    assert.throws(
      () => parseClaim({ ...claim, job: { ...claim.job, ...patch } }),
      undefined,
      JSON.stringify(patch).slice(0, 80),
    );
  // A PR job must never be mistaken for an error job and vice versa.
  const errorShaped = valid();
  errorShaped.job.mode = 'pull-request';
  assert.throws(() => parseClaim(errorShaped));
});

const START = 1_800_000_000_000;
const DEADLINE = START + 90 * 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const transport = (code, message = 'connect failure') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
const denied = (status) => Object.assign(new Error(`Executor endpoint returned ${status}`), { status });

/**
 * Lease keeper under mocked timers and clock: every heartbeat attempt is recorded
 * with its abort signal and settled explicitly by the test.
 */
function keeper(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  t.mock.method(console, 'error', () => {});
  const attempts = [];
  const lost = t.mock.fn();
  const lease = keepLease({
    runId: `autofix-${'a'.repeat(64)}`,
    deadlineAt: DEADLINE,
    leaseExpiresAt: START + 120_000,
    heartbeat: (signal) => {
      const attempt = { signal, ...Promise.withResolvers() };
      attempts.push(attempt);
      return attempt.promise;
    },
    onLost: lost,
    ...overrides,
  });
  t.after(lease.stop);
  return { attempts, lost, lease };
}

test('lease keeper retries transient transport failures only inside the confirmed lease', async (t) => {
  const { attempts, lost, lease } = keeper(t);
  t.mock.timers.tick(44_999);
  assert.equal(attempts.length, 0);
  t.mock.timers.tick(1);
  assert.equal(attempts.length, 1);
  // Nothing overlaps an in-flight heartbeat, however long it takes.
  t.mock.timers.tick(30_000);
  assert.equal(attempts.length, 1);
  attempts[0].reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  await flush();
  // An unconfirmed heartbeat never extends the lease; the retry lands inside the margin.
  assert.equal(lease.confirmedExpiresAt(), START + 120_000);
  assert.equal(lost.mock.callCount(), 0);
  t.mock.timers.tick(4_999);
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(1);
  assert.equal(attempts.length, 2);
  assert.equal(Date.now(), START + 80_000);
  attempts[1].reject(transport('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error https://worker.example/executor'));
  await flush();
  const logged = console.error.mock.calls
    .filter((call) => call.arguments[0] === '[autofix-executor] heartbeat failed')
    .at(-1);
  assert.match(logged.arguments[1].reason, /UND_ERR_CONNECT_TIMEOUT/);
  assert.doesNotMatch(logged.arguments[1].reason, /https?:\/\//);
  t.mock.timers.tick(5_000);
  assert.equal(attempts.length, 3);
  assert.equal(Date.now(), START + 85_000);
  attempts[2].resolve({ deadlineAt: DEADLINE, leaseExpiresAt: START + 205_000 });
  await flush();
  assert.equal(lease.confirmedExpiresAt(), START + 205_000);
  assert.equal(lost.mock.callCount(), 0);
  // The normal cadence resumes from the confirmed heartbeat.
  t.mock.timers.tick(44_999);
  assert.equal(attempts.length, 3);
  t.mock.timers.tick(1);
  assert.equal(attempts.length, 4);
  assert.equal(lost.mock.callCount(), 0);
});

test('lease keeper stops the run before the confirmed lease expires when no heartbeat is confirmed', async (t) => {
  const { attempts, lost, lease } = keeper(t);
  t.mock.timers.tick(45_000);
  for (let round = 0; round < 50 && !lost.mock.callCount(); round += 1) {
    attempts.at(-1).reject(transport('ENETUNREACH'));
    await flush();
    if (!lost.mock.callCount()) t.mock.timers.tick(5_000);
  }
  assert.equal(lost.mock.callCount(), 1);
  assert.equal(lease.confirmedExpiresAt(), START + 120_000);
  assert.ok(Date.now() <= START + 105_000, 'stopped at or before the safety margin');
  // Retries at 45s, 50s … 100s; the one that could not finish before the margin is not attempted.
  assert.equal(attempts.length, 12);
  t.mock.timers.tick(90 * 60_000);
  assert.equal(attempts.length, 12);
  assert.equal(lost.mock.callCount(), 1);
});

test('lease keeper fails closed at the safety margin while a heartbeat hangs', async (t) => {
  const { attempts, lost } = keeper(t);
  t.mock.timers.tick(45_000);
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(59_999);
  assert.equal(lost.mock.callCount(), 0);
  assert.equal(attempts[0].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(Date.now(), START + 105_000);
  assert.equal(lost.mock.callCount(), 1);
  assert.equal(attempts[0].signal.aborted, true);
  // A late answer to the cancelled heartbeat cannot revive the job.
  attempts[0].resolve({ deadlineAt: DEADLINE, leaseExpiresAt: START + 400_000 });
  await flush();
  t.mock.timers.tick(90 * 60_000);
  assert.equal(attempts.length, 1);
  assert.equal(lost.mock.callCount(), 1);
});

test('lease keeper aborts at once on Worker rejection, TLS failure or an unconfirmed lease', async (t) => {
  const cases = {
    'HTTP 401': (attempt) => attempt.reject(denied(401)),
    'HTTP 409': (attempt) => attempt.reject(denied(409)),
    'HTTP 500': (attempt) => attempt.reject(denied(500)),
    'TLS certificate': (attempt) => attempt.reject(transport('CERT_HAS_EXPIRED', 'certificate has expired')),
    'malformed JSON': (attempt) => attempt.reject(new SyntaxError('Unexpected token')),
    'empty body': (attempt) => attempt.resolve(null),
    'other deadline': (attempt) => attempt.resolve({ deadlineAt: DEADLINE + 1, leaseExpiresAt: START + 165_000 }),
    'expiry inside margin': (attempt) => attempt.resolve({ deadlineAt: DEADLINE, leaseExpiresAt: START + 59_999 }),
    'expiry past deadline': (attempt) => attempt.resolve({ deadlineAt: DEADLINE, leaseExpiresAt: DEADLINE + 1 }),
    'non-integer expiry': (attempt) => attempt.resolve({ deadlineAt: DEADLINE, leaseExpiresAt: '2026' }),
  };
  for (const [label, settle] of Object.entries(cases))
    await t.test(label, async (t) => {
      const { attempts, lost, lease } = keeper(t);
      t.mock.timers.tick(45_000);
      settle(attempts[0]);
      await flush();
      assert.equal(lost.mock.callCount(), 1);
      assert.equal(lease.confirmedExpiresAt(), START + 120_000);
      t.mock.timers.tick(60_000);
      assert.equal(attempts.length, 1);
      assert.equal(lost.mock.callCount(), 1);
    });
});

test('lease keeper stop cancels timers and the in-flight heartbeat without reporting loss', async (t) => {
  const { attempts, lost, lease } = keeper(t);
  t.mock.timers.tick(45_000);
  assert.equal(attempts.length, 1);
  lease.stop();
  assert.equal(attempts[0].signal.aborted, true);
  attempts[0].reject(denied(401));
  await flush();
  t.mock.timers.tick(90 * 60_000);
  assert.equal(attempts.length, 1);
  assert.equal(lost.mock.callCount(), 0);
  // A keeper stopped before its first heartbeat never sends one.
  const idle = keepLease({
    runId: `autofix-${'b'.repeat(64)}`,
    deadlineAt: DEADLINE,
    leaseExpiresAt: START + 120_000,
    heartbeat: () => assert.fail('heartbeat after stop'),
    onLost: () => assert.fail('loss after stop'),
  });
  idle.stop();
  t.mock.timers.tick(90 * 60_000);
});

test('lease keeper heartbeats early for a short resumed lease and rests once the lease is clipped to the deadline', async (t) => {
  const deadlineAt = START + 100_000;
  const { attempts, lost, lease } = keeper(t, { deadlineAt, leaseExpiresAt: START + 40_000 });
  // 40s left minus the margin leaves no room for a 45s wait plus a full attempt.
  t.mock.timers.tick(1);
  assert.equal(attempts.length, 1);
  attempts[0].resolve({ deadlineAt, leaseExpiresAt: deadlineAt });
  await flush();
  assert.equal(lease.confirmedExpiresAt(), deadlineAt);
  // A lease already reaching the absolute deadline cannot be extended, so no
  // further heartbeat is sent; the margin timer still ends the run on time.
  t.mock.timers.tick(84_998);
  assert.equal(attempts.length, 1);
  assert.equal(lost.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(Date.now(), deadlineAt - 15_000);
  assert.equal(lost.mock.callCount(), 1);
});

const throttled = (retryAfterSeconds) =>
  Object.assign(denied(429), retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
const WINDOW = 19 * 60_000;

/** Records real retry scheduling while each simulated request is settled explicitly. */
function model(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  t.mock.method(console, 'error', () => {});
  const controller = new AbortController();
  const attempts = [];
  const outcome = requestModel({
    runId: `autofix-${'a'.repeat(64)}`,
    send: () => {
      const attempt = Promise.withResolvers();
      attempts.push(attempt);
      return attempt.promise;
    },
    windowEndsAt: START + WINDOW,
    signal: controller.signal,
    ...overrides,
  });
  outcome.catch(() => {});
  return { attempts, controller, outcome };
}

test('Retry-After is accepted only as canonical nonnegative numeric seconds', () => {
  assert.equal(parseRetryAfterSeconds('7'), 7);
  assert.equal(parseRetryAfterSeconds('0'), 1);
  assert.equal(parseRetryAfterSeconds('2.25'), 3);
  assert.equal(parseRetryAfterSeconds('99999'), undefined);
  assert.equal(parseRetryAfterSeconds(' 12 '), 12);
  for (const header of [null, undefined, '', '-1', '1e3', 'Wed, 21 Oct 2026 07:28:00 GMT', '5s', 'NaN', 'Infinity'])
    assert.equal(parseRetryAfterSeconds(header), undefined, String(header));
});

test('model request honours the full relayed server delay before retrying', async (t) => {
  const { attempts, outcome } = model(t);
  await flush();
  assert.equal(attempts.length, 1);
  attempts[0].reject(throttled(7));
  await flush();
  // Nothing is sent before the full server delay has elapsed.
  t.mock.timers.tick(6_999);
  await flush();
  assert.equal(attempts.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(attempts.length, 2);
  assert.equal(Date.now(), START + 7_000);
  const response = { ok: true };
  attempts[1].resolve(response);
  await outcome;
});

test('model request returns a first successful response without waiting', async (t) => {
  const { attempts, outcome } = model(t);
  await flush();
  const response = { content: [] };
  attempts[0].resolve(response);
  await outcome;
  assert.equal(attempts.length, 1);
  assert.equal(Date.now(), START);
});

test('model request aborted during the throttle wait stops without another attempt', async (t) => {
  const { attempts, controller, outcome } = model(t);
  await flush();
  attempts[0].reject(throttled(30));
  await flush();
  t.mock.timers.tick(10_000);
  controller.abort();
  await assert.rejects(outcome, { name: 'AbortError' });
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(attempts.length, 1);
});

test('model request refuses a delay that ends past the remaining generation window', async (t) => {
  const { attempts, outcome } = model(t, { windowEndsAt: START + 10_000 });
  await flush();
  const error = throttled(10);
  attempts[0].reject(error);
  await assert.rejects(outcome, (thrown) => {
    assert.match(thrown.message, /beyond the remaining generation window/);
    assert.equal(thrown.cause, error);
    return true;
  });
  // No shorter wait is substituted and nothing else is sent.
  t.mock.timers.tick(WINDOW);
  await flush();
  assert.equal(attempts.length, 1);
});

test('model request does not retry when a delayed wakeup crosses the generation deadline', async (t) => {
  const { attempts, outcome } = model(t, { windowEndsAt: START + 10_000 });
  await flush();
  attempts[0].reject(throttled(2));
  await flush();
  t.mock.timers.tick(12_000);
  await assert.rejects(outcome, /window expired/);
  assert.equal(attempts.length, 1);
});

test('model request gives up after three throttled retries', async (t) => {
  const { attempts, outcome } = model(t);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await flush();
    assert.equal(attempts.length, attempt + 1);
    attempts[attempt].reject(throttled(2));
    await flush();
    t.mock.timers.tick(2_000);
  }
  await flush();
  assert.equal(attempts.length, 4);
  assert.equal(Date.now(), START + 6_000);
  const last = throttled(2);
  attempts[3].reject(last);
  await assert.rejects(outcome, (thrown) => {
    assert.match(thrown.message, /after 3 retries/);
    assert.equal(thrown.cause, last);
    return true;
  });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(attempts.length, 4);
});

test('model request fails at once on a 429 without a delay or any other failure', async (t) => {
  for (const failure of [
    throttled(undefined),
    Object.assign(denied(429), { retryAfterSeconds: '7' }),
    Object.assign(denied(429), { retryAfterSeconds: 0 }),
    Object.assign(denied(429), { retryAfterSeconds: 3601 }),
    Object.assign(denied(503), { retryAfterSeconds: 30 }),
    denied(401),
    denied(403),
    denied(400),
    transport('UND_ERR_CONNECT_TIMEOUT'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
  ])
    await t.test(`${failure.status ?? failure.name}: ${failure.message}`, async (t) => {
      const { attempts, outcome } = model(t);
      await flush();
      attempts[0].reject(failure);
      await assert.rejects(outcome, (thrown) => thrown === failure);
      t.mock.timers.tick(WINDOW);
      await flush();
      assert.equal(attempts.length, 1);
    });
});
