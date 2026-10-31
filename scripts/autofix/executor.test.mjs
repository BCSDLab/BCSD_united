import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaim } from './executor.mjs';

const valid = () => ({
  version: 1,
  runId: `autofix-${'a'.repeat(64)}`,
  leaseToken: 'b'.repeat(64),
  attempt: 1,
  deadlineAt: Date.now() + 60_000,
  job: {
    identity: { source: 'sentry', sourceId: '123', project: 'koin-united-prod', app: 'web' },
    owner: 'BCSDLab',
    repository: 'BCSD_united',
    baseSha: 'c'.repeat(40),
    baseBranch: 'develop',
    issueNumber: 7,
    branch: 'fix/7',
    domain: 'common',
    diagnostics: { summary: 'redacted' },
    context: { app: 'web', route: '/', requestMethod: 'GET' },
  },
});

test('Rocky executor accepts only a fresh fixed-repository lease with safe route', () => {
  const claim = valid();
  assert.equal(parseClaim(claim).runId, claim.runId);
  for (const patch of [
    { runId: 'arbitrary-job' },
    { leaseToken: 'not-a-lease' },
    { deadlineAt: 'tomorrow' },
    { deadlineAt: Date.now() - 1 },
    { deadlineAt: Date.now() + 91 * 60_000 },
    { job: { ...claim.job, repository: 'other' } },
    { job: { ...claim.job, context: { ...claim.job.context, route: '//other' } } },
    { job: { ...claim.job, context: { ...claim.job.context, requestMethod: 'POST' } } },
  ])
    assert.throws(() => parseClaim({ ...claim, ...patch }));
});
