import test from 'node:test';
import assert from 'node:assert/strict';
import { isPullRequest, parseClaim } from './executor.mjs';

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

const pullRequest = () => ({
  version: 1,
  runId: `autofix-${'d'.repeat(64)}`,
  leaseToken: 'e'.repeat(64),
  attempt: 1,
  deadlineAt: Date.now() + 60_000,
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
