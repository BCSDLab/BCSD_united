import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchInputs, main, publishCandidates, reviewPair } from './issue-publisher.mjs';

const original = '00000000-0000-4000-8000-000000000001';
const rerun = '00000000-0000-4000-8000-000000000002';
const bot = { id: 41898282, type: 'Bot' };
const human = { id: 2, type: 'User' };

function product(changes = {}) {
  return {
    screenId: 'benefitstore',
    viewport: 'desktop',
    status: 'product-failure',
    signature: 'unexpected-not-found',
    ...changes,
  };
}

function pair() {
  const first = {
    schemaVersion: 1,
    runId: original,
    parentRunId: null,
    appSha: 'a'.repeat(40),
    harnessSha: 'b'.repeat(40),
    environment: 'stage',
    observations: [product()],
  };
  return [first, { ...structuredClone(first), runId: rerun, parentRunId: original }];
}

function issue(body, changes = {}) {
  return { number: 7, state: 'open', user: bot, body, ...changes };
}

test('matches a partial rerun by inventory id, viewport and fixed product signature', () => {
  const [first, second] = pair();
  first.observations.push(product({ viewport: 'mobile', signature: 'rendered-error-boundary' }));
  const [candidate] = reviewPair(first, second);
  assert.match(candidate.body, /apps\/web\/src\/routes\/benefitstore\.index\.tsx/);
  assert.match(candidate.body, /`\/benefitstore`/);
  assert.ok([original, rerun, first.appSha, first.harnessSha].every((id) => candidate.evidence.includes(id)));
  for (const changes of [{ screenId: 'articles' }, { viewport: 'mobile' }, { signature: 'rendered-error-boundary' }]) {
    assert.deepEqual(reviewPair(first, { ...second, observations: [product(changes)] }), []);
  }
  for (const status of ['passed', 'blocked', 'harness-error', 'unverified', 'skipped']) {
    const nonProduct = [product({ status, signature: null })];
    assert.deepEqual(reviewPair(first, { ...second, observations: nonProduct }), []);
    assert.deepEqual(reviewPair({ ...first, observations: nonProduct }, second), []);
  }
});

test('rejects broken lineage and cross-commit pairs before publishing', () => {
  const [first, second] = pair();
  for (const changes of [
    { runId: original },
    { parentRunId: null },
    { parentRunId: rerun },
    { appSha: 'c'.repeat(40) },
    { harnessSha: 'c'.repeat(40) },
  ]) {
    assert.throws(() => reviewPair(first, { ...second, ...changes }));
  }
  assert.throws(() => reviewPair({ ...first, parentRunId: rerun }, second));
});

test('rejects raw reports, injected values, unknown fields, signatures and ambiguous observations without echoing them', () => {
  const secret = 'sensitive-free-text';
  const [first, second] = pair();
  const invalid = [
    null,
    [],
    { ...second, schemaVersion: 2 },
    { ...second, environment: 'production' },
    { ...second, log: secret },
    { ...second, runId: secret },
    { ...second, appSha: 'abc' },
    { ...second, harnessSha: 'b'.repeat(40) + secret },
    { ...second, observations: [] },
    { ...second, observations: [product(), product()] },
    ...[
      { screenId: secret },
      { signature: secret },
      { viewport: secret },
      { status: secret },
      { error: secret },
      { status: 'blocked' },
      { signature: null },
    ].map((changes) => ({ ...second, observations: [product(changes)] })),
  ];
  for (const bad of invalid) {
    assert.throws(
      () => reviewPair(first, bad),
      (error) => !error.message.includes(secret),
    );
    assert.throws(() => dispatchInputs(first, bad));
  }
  for (const screenId of ['not-found', 'articles-id']) {
    assert.throws(() => reviewPair(first, { ...second, observations: [product({ screenId })] }));
  }
});

test('open issue identity is stable across commits; evidence identity changes with each SHA pair', () => {
  const [first, second] = pair();
  const [a] = reviewPair(first, second);
  for (const key of ['appSha', 'harnessSha']) {
    const [b] = reviewPair({ ...first, [key]: 'c'.repeat(40) }, { ...second, [key]: 'c'.repeat(40) });
    assert.equal(a.marker, b.marker);
    assert.notEqual(a.evidenceMarker, b.evidenceMarker);
  }
});

test('creates one issue, ignoring pull requests, closed issues and user-authored marker copies', async () => {
  const candidates = reviewPair(...pair());
  const [{ title, body }] = candidates;
  const posts = [];
  const result = await publishCandidates(candidates, async (route, payload) => {
    if (payload) return posts.push({ route, payload });
    assert.match(route, /^\/issues\?state=open&/);
    return [issue(body, { user: human }), issue(body, { pull_request: {} }), issue(body, { state: 'closed' })];
  });
  assert.deepEqual(result, { created: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(posts, [{ route: '/issues', payload: { title, body } }]);
});

test('paginates open issues and comments, ignores human evidence and records each new SHA pair once', async () => {
  const candidates = reviewPair(...pair());
  const [candidate] = candidates;
  const old = pair().map((run) => ({ ...run, harnessSha: 'c'.repeat(40) }));
  const [previous] = reviewPair(...old);
  const comments = [{ body: candidate.evidence, user: human }];
  const posts = [];
  const request = async (route, payload) => {
    if (payload) {
      posts.push({ route, payload });
      assert.equal(route, '/issues/7/comments');
      comments.push({ user: bot, body: payload.body });
      return;
    }
    const url = new URL(route, 'https://example.invalid');
    assert.equal(url.searchParams.get('per_page'), '100');
    if (url.searchParams.get('page') === '1') return Array(100).fill({ user: human });
    assert.equal(url.searchParams.get('page'), '2');
    return url.pathname === '/issues' ? [issue(previous.body)] : comments;
  };
  assert.deepEqual(await publishCandidates(candidates, request), { created: 0, updated: 1, unchanged: 0 });
  assert.deepEqual(await publishCandidates(candidates, request), { created: 0, updated: 0, unchanged: 1 });
  assert.deepEqual(posts, [{ route: '/issues/7/comments', payload: { body: candidate.evidence } }]);
});

test('replay of the original SHA pair needs neither a new issue nor a comment lookup', async () => {
  const candidates = reviewPair(...pair());
  const result = await publishCandidates(candidates, async (route, payload) => {
    assert.match(route, /^\/issues\?state=open&/);
    assert.equal(payload, undefined);
    return [issue(candidates[0].body)];
  });
  assert.equal(result.unchanged, 1);
});

test('fails closed on ambiguous open matches, failed lookups or uncertain writes; never retries POST', async () => {
  const candidates = reviewPair(...pair());
  const existing = issue(candidates[0].body);
  let posts = 0;
  for (const response of [null, [existing, existing], [issue(candidates[0].body, { number: 0 })]]) {
    await assert.rejects(
      publishCandidates(candidates, async (_, payload) => {
        if (payload) posts++;
        return response;
      }),
    );
  }
  assert.equal(posts, 0);
  await assert.rejects(
    publishCandidates(candidates, async (_, payload) => {
      if (!payload) return [];
      posts++;
      throw new Error('connection lost');
    }),
    /connection lost/,
  );
  assert.equal(posts, 1);
  assert.deepEqual(await publishCandidates([], () => assert.fail('no request expected')), {
    created: 0,
    updated: 0,
    unchanged: 0,
  });
});

test('CLI validates and previews offline, emits compact dispatch strings, and rejects raw evidence', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-publisher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [first, second] = pair();
  const baseline = path.join(dir, 'first.json');
  const confirmation = path.join(dir, 'second.json');
  const options = ['--baseline', baseline, '--confirmation', confirmation];
  await writeFile(baseline, JSON.stringify(first, null, 2));
  await writeFile(confirmation, JSON.stringify(second, null, 2));
  assert.deepEqual(JSON.parse(await main(['--validate-only', ...options], {})), { confirmed: 1 });
  const [{ title, body }] = reviewPair(first, second);
  assert.deepEqual(JSON.parse(await main(['--dry-run', ...options], {})), [{ title, body }]);
  assert.deepEqual(JSON.parse(await main(['--dispatch-inputs', ...options], {})), {
    baseline: JSON.stringify(first),
    confirmation: JSON.stringify(second),
  });
  await writeFile(confirmation, 'sensitive-free-text');
  await assert.rejects(main(['--dispatch-inputs', ...options], {}), /^Error: Malformed JSON$/);
  await assert.rejects(main(['--publish', ...options], {}), /trusted develop dispatch/);
});

test('publish only accepts hosted develop dispatch data, and rechecks size and schema before any API access', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const event = path.join(dir, 'event.json');
  const env = {
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/develop',
    GITHUB_REPOSITORY: 'BCSDLab/BCSD_united',
    GITHUB_WORKFLOW_REF: 'BCSDLab/BCSD_united/.github/workflows/harness-issues.yml@refs/heads/develop',
    GITHUB_EVENT_PATH: event,
    GITHUB_TOKEN: 'unit-test',
  };
  for (const changes of [
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REPOSITORY: 'other/fork' },
    { GITHUB_WORKFLOW_REF: 'other' },
  ]) {
    await assert.rejects(main(['--publish'], { ...env, ...changes }), /trusted develop dispatch/);
  }
  for (const inputs of [
    { baseline: '{}', confirmation: ' '.repeat(65535) },
    { baseline: '{}', confirmation: '{}', extra: 'PII' },
    { baseline: '{}', confirmation: '{}' },
  ]) {
    await writeFile(event, JSON.stringify({ inputs }));
    await assert.rejects(main(['--publish'], env), /input limit|Invalid dispatch inputs|Invalid normalized screen run/);
  }
  const [first, second] = pair();
  second.observations = [product({ status: 'passed', signature: null })];
  await writeFile(event, JSON.stringify({ inputs: JSON.parse(dispatchInputs(first, second)) }));
  assert.deepEqual(JSON.parse(await main(['--publish'], env)), { created: 0, updated: 0, unchanged: 0 });
});
