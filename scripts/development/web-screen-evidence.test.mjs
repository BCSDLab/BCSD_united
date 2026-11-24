import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { classifyVisit, normalizedScreenRun, parentIdentity, validateScreenRun } from './web-screen-evidence.mjs';

const origin = 'http://localhost:3000';
const identity = {
  schemaVersion: 1,
  environment: 'stage',
  runId: '12345678-1234-4321-9876-123456789abc',
  appSha: 'a'.repeat(40),
  harnessSha: 'b'.repeat(40),
  parentRunId: null,
};
const spec = { id: 'articles', path: '/articles', route: 'articles.index.tsx', access: 'public' };
const ids = new Set(['articles', 'auth']);
const visit = {
  state: { url: `${origin}/articles`, ready: true, hydrated: true, notFound: false, errorBoundaries: [] },
  record: { documentStatus: 200, documentLoads: 1, failedRequests: [], networkFailures: 0 },
  networkIdle: true,
};
const classify = (extra) =>
  classifyVisit({ screen: spec, origin, expectedPath: spec.path, viewport: 'desktop', stage: true, visit, ...extra });

test('only stable target observations with direct rendered evidence are product failures', () => {
  assert.equal(classify({ passed: true }), 'passed');
  assert.equal(classify({}), 'unverified'); // Even if a console error or target timeout marked the raw visit failed.
  const failure = { ...visit, state: { ...visit.state, errorBoundaries: ['not evidence to export'] } };
  assert.equal(classify({ visit: failure }), 'rendered-error-boundary');
  for (const change of [
    { navigationError: 'failed' },
    { networkIdle: false },
    { state: { ...failure.state, hydrated: false } },
    { state: { ...failure.state, url: `${origin}/` } },
    { state: { ...failure.state, url: 'https://untrusted.invalid/articles' } },
    ...[
      { documentLoads: 2 },
      { documentStatus: 503 },
      { documentStatus: null },
      { failedRequests: [{}] },
      { networkFailures: 1 },
    ].map((overrides) => ({ record: { ...visit.record, ...overrides } })),
  ])
    assert.equal(classify({ visit: { ...failure, ...change } }), 'unverified');
  assert.equal(classify({ visit: failure, stage: false }), 'unverified');
  const guard = { ...spec, access: 'authenticated', desktopGuard: '/' };
  assert.equal(classify({ visit: failure, screen: guard, session: true }), 'unverified');
  assert.equal(classify({ passed: true, screen: guard, session: true }), 'unverified');
  assert.equal(classify({ visit: failure, screen: { ...spec, access: 'login' } }), 'unverified');
  assert.equal(classify({ visit: failure, screen: { ...spec, access: 'authenticated' }, session: false }), 'blocked');
  assert.equal(classify({ passed: true, screen: { ...spec, access: 'authenticated' }, session: true }), 'unverified');
  const missing = { ...visit, state: { ...visit.state, notFound: true } };
  assert.equal(classify({ visit: missing }), 'unexpected-not-found');
  for (const change of [{ expect: 'not-found' }, { source: 'stage fixture' }, { route: 'articles.$id.index.tsx' }])
    assert.equal(classify({ visit: missing, screen: { ...spec, ...change } }), 'unverified');
});

const screenRun = () =>
  normalizedScreenRun(identity, [{ ...spec, desktop: { outcome: 'rendered-error-boundary' } }], ids);

test('normalized reports contain only allowlisted fields and represent missing viewports explicitly', () => {
  const privateValue = 'sentinel-private-data';
  const raw = [
    { ...spec, path: privateValue, desktop: { outcome: 'rendered-error-boundary', failures: [privateValue] } },
    { id: 'auth', access: 'login', desktop: { outcome: 'unverified', screenshot: privateValue } },
  ];
  const result = normalizedScreenRun(identity, raw, ids);
  assert.deepEqual(result.observations, [
    { screenId: 'articles', viewport: 'desktop', status: 'product-failure', signature: 'rendered-error-boundary' },
    { screenId: 'articles', viewport: 'mobile', status: 'harness-error', signature: null },
    { screenId: 'auth', viewport: 'desktop', status: 'unverified', signature: null },
    { screenId: 'auth', viewport: 'mobile', status: 'unverified', signature: null },
  ]);
  assert.ok(!JSON.stringify(result).includes(privateValue));
  const disabled = normalizedScreenRun(identity, [{ ...spec, access: 'disabled' }], ids);
  assert.ok(disabled.observations.every((row) => row.status === 'skipped' && row.signature === null));
});

test('strict run validation rejects replay ambiguity and accidentally serialized data', () => {
  const r = screenRun();
  assert.equal(validateScreenRun(r, ids), r);
  for (const patch of [
    { parentRunId: r.runId },
    { runId: `${r.runId}\n` },
    { schemaVersion: 2 },
    { environment: 'prod' },
    { harnessSha: 'b'.repeat(7) },
    { appSha: 'A'.repeat(40) },
    { raw: {} },
    { observations: [] },
    { observations: [r.observations[0], r.observations[0]] },
    ...[
      { screenId: 'not-in-inventory' },
      { status: 'failed' },
      { status: 'passed' },
      { viewport: 'watch' },
      { signature: 'private error' },
      { signature: null },
      { error: 'sensitive text' },
    ].map((o) => ({ observations: [{ ...r.observations[0], ...o }] })),
  ])
    assert.throws(() => validateScreenRun({ ...r, ...patch }, ids));
});

test('a rerun links only to a validated root report with matching app/harness and screen scope', () => {
  const r = screenRun();
  const link = (root, selected = ['articles']) => parentIdentity(root, ids, selected, r.appSha, r.harnessSha);
  assert.equal(link(r), r.runId);
  for (const patch of [
    { environment: 'local' },
    { appSha: r.harnessSha },
    { harnessSha: r.appSha },
    { parentRunId: '12345678-1234-4321-9876-123456789ab1' },
  ])
    assert.throws(() => link({ ...r, ...patch }));
  assert.throws(() => link(r, ['auth']));
});

const protectedSpec = (id, path) => ({ id, path, access: 'authenticated' });
const screens = [
  spec,
  protectedSpec('chat', '/chat/:postId'),
  protectedSpec('participants', '/p/:postId'),
  protectedSpec('report', '/p/:postId/:userId'),
  protectedSpec('write', '/review/:shopId'),
  protectedSpec('edit', '/review/:shopId/:ownReviewId'),
  protectedSpec('flag', '/review/:shopId/:otherReviewId'),
];

// Exercise the actual browser-side expressions against inert, in-memory read responses.
// No subprocess, browser, network, real credentials, or write endpoint is involved.
function preview({ stage = 'https://api.stage.koreatech.in', anonymous = true } = {}) {
  const calls = [],
    inputs = [];
  const location = { origin, pathname: '/auth' };
  let signedIn = !anonymous;
  const fixtures = new Map([
    ['/api/callvan?joined=true&page=1&limit=50', { posts: [{ id: 123, is_joined: true, current_participants: 1 }] }],
    ['/api/callvan/posts/123', { id: 123, participants: [{ is_me: true, user_id: 9001, name: 'private-name' }] }],
    ['/api/shops/11', { id: 11 }],
    ['/api/shops/11/reviews/me?sorter=LATEST', { reviews: [] }],
    [
      '/api/shops/11/reviews?sorter=LATEST',
      { reviews: [{ is_mine: false, is_reported: false, review_id: 9827, content: 'private-text' }] },
    ],
  ]);
  const fetch = async (path, options) => {
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.redirect, 'error');
    calls.push(path);
    const data = path === '/api/v2/web/auth/session' ? { authenticated: signedIn } : fixtures.get(path);
    return { ok: Boolean(data), status: data ? 200 : 404, headers: { get: () => stage }, json: async () => data };
  };
  const document = { activeElement: { matches: () => true }, querySelector: () => ({ __reactProps$test: {} }) };
  return {
    calls,
    inputs,
    context: {
      origin,
      cdp: {
        send: async (method) => {
          if (method === 'Input.insertText') inputs.push(method);
        },
      },
      page: {
        evaluate: async (expression) => runInNewContext(expression, { fetch, location, document, AbortSignal }),
        click: async (label) => {
          if (label === 'submit stage login') {
            signedIn = true;
            location.pathname = '/setting';
          }
        },
      },
    },
  };
}

async function withStageInputs(t, enabled) {
  const env = {
    KOIN_STAGE_LOGIN_ID: enabled ? 'inert-test-id' : '',
    MAESTRO_USER_PASSWORD: enabled ? 'inert-test-value' : '',
    KOIN_STAGE_CALLVAN_POST_ID: '',
    KOIN_STAGE_SHOP_ID: '11',
    AUTOFIX_OFFLINE_SMOKE: '',
  };
  for (const [key, value] of Object.entries(env)) {
    const saved = process.env[key];
    t.after(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
    process.env[key] = value;
  }
  return import(`./web-screen-auth.mjs?test-credentials=${enabled}`);
}
const waitFor = async (_, probe) => assert.ok(await probe());

test('stage proof precedes input; missing credentials and nonstage/opaque gateways cannot sign in', async (t) => {
  const { stagePreflight } = await withStageInputs(t, false);
  const verified = preview();
  const result = await stagePreflight(verified.context, screens, waitFor);
  assert.equal(result.findings.stageOrigin, 'verified');
  assert.equal(result.findings.login, 'missing-stage-credentials');
  assert.equal(result.routes.get('edit').blocked, 'missing-stage-credentials');
  assert.ok(!result.routes.has(spec.id));
  assert.deepEqual(verified.calls, ['/api/v2/web/auth/session']);
  assert.deepEqual(verified.inputs, []);
});

test('a similar origin, non-anonymous session and wrong port block credentials even when supplied', async (t) => {
  const { stagePreflight } = await withStageInputs(t, true);
  for (const [browser, url] of [
    [preview({ stage: 'https://api.stage.koreatech.in.example' }), origin],
    [preview({ anonymous: false }), origin],
    [preview(), 'http://localhost:3001'],
  ]) {
    const { findings, routes } = await stagePreflight({ ...browser.context, origin: url }, screens, waitFor);
    assert.equal(findings.login, 'stage-origin-unverified');
    assert.ok([...routes.values()].every((v) => v.blocked === 'stage-origin-unverified'));
    assert.deepEqual(browser.inputs, []);
  }
});

test('one login and one GET per prerequisite; missing dependencies block only dependent screens', async (t) => {
  const { stagePreflight } = await withStageInputs(t, true);
  const browser = preview();
  const { findings, routes } = await stagePreflight(browser.context, screens, waitFor);
  assert.equal(findings.login, 'verified');
  assert.equal(browser.inputs.length, 2);
  assert.equal(browser.calls.filter((p) => p === '/api/v2/web/auth/session').length, 2); // Anonymous + authenticated proofs.
  const reads = browser.calls.filter((p) => p !== '/api/v2/web/auth/session');
  assert.equal(reads.length, 5);
  assert.equal(new Set(reads).size, reads.length);
  assert.deepEqual(routes.get('chat'), { path: '/chat/123' });
  assert.deepEqual(routes.get('participants'), { path: '/p/123' });
  assert.deepEqual(routes.get('report'), { blocked: 'second-callvan-participant' });
  assert.deepEqual(routes.get('edit'), { blocked: 'account-owned-review' });
  assert.deepEqual(routes.get('flag'), { path: '/review/11/9827' });
  assert.deepEqual(routes.get('write'), { path: '/review/11' });
  assert.doesNotMatch(JSON.stringify(findings), /private-|9827|123|9001|inert-test/);
  assert.ok(!routes.has(spec.id));
});
