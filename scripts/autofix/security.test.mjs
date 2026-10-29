import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedPath, dispatchConfig, marker, safeRoute, validateDispatch } from './common.mjs';
import { applyManifest, validateManifest } from './patch.mjs';
import { permitted } from './tool-policy.mjs';
import { matchesRoute } from './source-graph.mjs';
import { boundedJson, cloudflareDiagnostics, diagnosticUrl, redact, sentryDiagnostics } from './diagnostics.mjs';

const payload = {
  source: 'sentry',
  sourceId: '12345',
  project: 'koin-prod',
  app: 'web',
  scope: { organization: 'bcsdlab' },
};
const cloudflare = {
  source: 'cloudflare',
  sourceId: 'a'.repeat(32),
  project: 'koin-api',
  app: 'api',
  scope: { accountId: 'b'.repeat(32), policyId: 'c'.repeat(32), workerName: 'koin-api' },
};
const config = {
  organization: 'bcsdlab',
  sentryApps: { 'koin-prod': 'web' },
  cloudflareSources: [{ ...cloudflare.scope, app: 'api' }],
};
const event = { action: 'error-autofix', client_payload: payload };

test('provider configuration can omit the other provider without accepting its events', () => {
  const browserOnly = dispatchConfig({
    SENTRY_ORGANIZATION: 'bcsdlab',
    SENTRY_PROJECT_APPS: '{"koin-prod":"web"}',
    CLOUDFLARE_SOURCES: '',
  });
  assert.deepEqual(validateDispatch(event, 'repository_dispatch', browserOnly), payload);
  assert.throws(() => validateDispatch({ ...event, client_payload: cloudflare }, 'repository_dispatch', browserOnly));
  const workerOnly = dispatchConfig({
    SENTRY_PROJECT_APPS: '',
    CLOUDFLARE_SOURCES: JSON.stringify(config.cloudflareSources),
  });
  assert.deepEqual(
    validateDispatch({ ...event, client_payload: cloudflare }, 'repository_dispatch', workerOnly),
    cloudflare,
  );
  assert.throws(() => validateDispatch(event, 'repository_dispatch', workerOnly));
});

test('dispatch accepts only exact allowlisted provider identity and manual JSON inputs', () => {
  assert.deepEqual(validateDispatch(event, 'repository_dispatch', config), payload);
  assert.deepEqual(
    validateDispatch({ inputs: { identity: JSON.stringify(payload) } }, 'workflow_dispatch', config),
    payload,
  );
  assert.deepEqual(
    validateDispatch({ ...event, client_payload: cloudflare }, 'repository_dispatch', config),
    cloudflare,
  );
  for (const patch of [
    { sourceId: 12345 },
    { sourceId: '00123' },
    { sourceId: '1\nrun' },
    { scope: { organization: 'other' } },
    { project: 'other' },
    { app: 'api' },
    { prompt: 'execute this' },
    { source: 'other' },
  ]) {
    assert.throws(() =>
      validateDispatch({ ...event, client_payload: { ...payload, ...patch } }, 'repository_dispatch', config),
    );
  }
  for (const patch of [
    { sourceId: '../data' },
    { app: 'web' },
    { project: 'another-worker' },
    { scope: { ...cloudflare.scope, policyId: 'd'.repeat(32) } },
    { scope: { ...cloudflare.scope, url: 'https://evil.test' } },
  ]) {
    assert.throws(() =>
      validateDispatch({ ...event, client_payload: { ...cloudflare, ...patch } }, 'repository_dispatch', config),
    );
  }
  assert.throws(() => validateDispatch(event, 'pull_request', config));
  assert.throws(() => validateDispatch({ ...event, action: 'other' }, 'repository_dispatch', config));
  assert.equal(marker(payload), '<!-- error-autofix:sentry:bcsdlab:koin-prod:12345 -->');
  assert.notEqual(marker(payload), marker(cloudflare));
});

test('browser diagnostics require canonical browser project, safe route and source frame', () => {
  const canonical = { id: payload.sourceId, project: { slug: payload.project }, title: 'Error token=secret' };
  const browserEvent = {
    groupID: payload.sourceId,
    platform: 'javascript',
    sdk: { name: 'sentry.javascript.react' },
    eventID: 'f'.repeat(32),
    entries: [
      {
        type: 'request',
        data: { url: 'https://koreatech.in/auth?token=hidden', headers: { Authorization: 'private' } },
      },
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value: 'user@example.com password=hidden',
              stacktrace: {
                frames: [{ filename: 'src/utils/value.ts', lineNo: 12, inApp: true, context: 'private source' }],
              },
            },
          ],
        },
      },
    ],
  };
  const result = sentryDiagnostics(payload, canonical, browserEvent, ['koreatech.in']);
  assert.equal(result.route, '/auth');
  assert.equal(result.exceptions[0].frames[0].filename, 'src/utils/value.ts');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.throws(() =>
    sentryDiagnostics(payload, canonical, { ...browserEvent, sdk: { name: 'sentry.javascript.cloudflare' } }, [
      'koreatech.in',
    ]),
  );
  assert.throws(() =>
    sentryDiagnostics(payload, { ...canonical, project: { slug: 'other' } }, browserEvent, ['koreatech.in']),
  );
  assert.throws(() => sentryDiagnostics(payload, canonical, browserEvent, ['other.example']));
  const crossed = structuredClone(browserEvent);
  crossed.entries[1].data.values[0].stacktrace.frames[0].filename = 'apps/api/src/index.ts';
  assert.throws(() => sentryDiagnostics(payload, canonical, crossed, ['koreatech.in']));
});

test('Cloudflare diagnostic retrieval fixes origin and binds stored scope without inventing evidence', () => {
  const url = diagnosticUrl('https://diagnostics.example', cloudflare);
  assert.equal(url.origin, 'https://diagnostics.example');
  assert.equal(url.pathname, `/diagnostics/cloudflare/${cloudflare.sourceId}`);
  assert.equal(url.searchParams.get('workerName'), 'koin-api');
  for (const origin of [
    'http://diagnostics.example',
    'https://user:secret@diagnostics.example',
    'https://diagnostics.example/extra',
    'https://diagnostics.example?token=secret',
  ])
    assert.throws(() => diagnosticUrl(origin, cloudflare));
  const record = {
    version: 1,
    identity: cloudflare,
    capturedAt: '2026-10-28T00:00:00Z',
    summary: 'token=private',
    details: {
      alertType: 'opaque-policy-notification',
      timestamp: 1793145600,
      data: { count: 42, headers: { Authorization: 'private' }, message: 'token=secret' },
    },
  };
  const result = cloudflareDiagnostics(cloudflare, record, config);
  assert.equal(result.route, null);
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.title.includes('private'), false);
  assert.equal(result.data.count, 42);
  assert.equal(JSON.stringify(result.data).includes('private'), false);
  assert.equal(JSON.stringify(result.data).includes('secret'), false);
  assert.throws(() =>
    cloudflareDiagnostics(cloudflare, { ...record, identity: { ...cloudflare, app: 'web' } }, config),
  );
  assert.throws(() =>
    cloudflareDiagnostics(
      cloudflare,
      { ...record, details: { ...record.details, request: { url: 'https://evil.test' } } },
      config,
    ),
  );
  assert.throws(() =>
    cloudflareDiagnostics(cloudflare, { ...record, details: { ...record.details, data: [] } }, config),
  );
});

test('diagnostic redaction and bounded streaming prevent credential and oversized input', async () => {
  const clean = redact('Bearer abc password=hidden test@example.com https://example.com/?secret=x 192.168.0.1');
  for (const secret of ['abc', 'hidden', 'test@example.com', 'secret=x', '192.168.0.1'])
    assert.equal(clean.includes(secret), false);
  assert.equal(redact('x'.repeat(20000)).length, 2000);
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(boundedJson(new Response('x'.repeat(100)), 50), /limit/);
  await assert.rejects(boundedJson(new Response('', { status: 403 })), /403/);
});

test('canonical routes strip secrets and refuse external destinations', () => {
  assert.equal(safeRoute('https://koreatech.in/auth?token=secret#private', ['koreatech.in']), '/auth');
  for (const value of [
    'https://evil.example/auth',
    'javascript:alert(1)',
    'https://user:pass@koreatech.in/auth',
    'https://koreatech.in//evil',
    'https://koreatech.in/%2fsecret',
  ])
    assert.equal(safeRoute(value, ['koreatech.in']), null);
});

test('patch scope excludes configuration, symlinks, generated files and oversized data', () => {
  assert.equal(allowedPath('apps/web/src/routes/shop.$id.tsx'), true);
  assert.equal(allowedPath('apps/api/src/auth.ts'), true);
  assert.equal(allowedPath('apps/api/src/db/schema.ts'), false);
  assert.equal(allowedPath('tests/autofix/regression.test.mjs'), true);
  for (const path of [
    'src/index.ts',
    'workers/koin-api/src/index.ts',
    'apps/web/src/../package.json',
    'apps/web/src/.env',
    'apps/web/src/generated/log.ts',
    'apps/web/src/routeTree.gen.ts',
    'apps/api/src/generated/schema.ts',
    'apps/api/package.json',
    'apps/error-automation/src/index.ts',
    '.github/workflows/run.yml',
    'scripts/autofix/verify.mjs',
    'pnpm-lock.yaml',
    'tests/other.test.mjs',
    '/apps/web/src/index.ts',
    'apps\\web\\src\\index.ts',
  ])
    assert.equal(allowedPath(path), false, path);
  for (const path of [
    'apps/api/src/domains/identity/web.test.ts',
    'apps/web/src/value.spec.tsx',
    'apps/api/src/fixtures/value.ts',
    'apps/api/src/domains/team/tests/value.ts',
  ])
    assert.equal(allowedPath(path), false, path);
  assert.throws(() =>
    validateManifest({
      version: 1,
      files: [{ path: 'apps/web/src/file.ts', before: null, content: 'x'.repeat(256001) }],
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: 1,
      files: Array.from({ length: 25 }, (_, index) => ({
        path: `apps/api/src/${index}.ts`,
        before: null,
        content: '',
      })),
    }),
  );
  assert.throws(() =>
    validateManifest({
      version: 1,
      files: [
        { path: 'apps/web/src/a.ts', before: null, content: '' },
        { path: 'apps/web/src/a.ts', before: null, content: '' },
      ],
    }),
  );
});

test('tool policy does not let diagnostic instructions grant execution or secret reads', () => {
  assert.equal(permitted('Read', 'error-input/diagnostics.json'), true);
  assert.equal(permitted('Edit', 'apps/web/src/utils/value.ts'), true);
  assert.equal(permitted('Edit', 'apps/api/src/auth.ts'), true);
  assert.equal(permitted('Read', 'apps/api/src/db/schema.ts'), true);
  assert.equal(permitted('Write', 'apps/api/src/db/schema.ts'), false);
  for (const [tool, path] of [
    ['Bash', 'apps/web/src/a.ts'],
    ['Read', '.git/config'],
    ['Read', '/proc/self/environ'],
    ['Read', 'error-input/context.json'],
    ['Write', 'scripts/autofix/tool-policy.mjs'],
    ['Write', 'error-input/diagnostics.json'],
    ['Write', 'apps/error-automation/src/index.ts'],
    ['Read', 'src/index.ts'],
    ['WebFetch', 'apps/web/src/a.ts'],
  ])
    assert.equal(permitted(tool, path), false);
  assert.equal(permitted('Read', 'apps/api/src/domains/identity/web.test.ts'), true);
  assert.equal(permitted('Write', 'apps/api/src/domains/identity/web.test.ts'), false);
});

test('independent application rejects changed baselines and symlink parents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-guard-'));
  try {
    await mkdir(join(root, 'apps/web/src'), { recursive: true });
    await writeFile(join(root, 'apps/web/src/a.ts'), 'existing');
    await assert.rejects(
      applyManifest({ version: 1, files: [{ path: 'apps/web/src/a.ts', before: null, content: 'overwrite' }] }, root),
      /Baseline mismatch/,
    );
    await applyManifest(
      { version: 1, files: [{ path: 'apps/web/src/b.ts', before: null, content: 'export const b = 1;' }] },
      root,
    );
    assert.equal(await readFile(join(root, 'apps/web/src/b.ts'), 'utf8'), 'export const b = 1;');
    if (process.platform !== 'win32') {
      await symlink(tmpdir(), join(root, 'apps/web/src/link'));
      await assert.rejects(
        applyManifest(
          { version: 1, files: [{ path: 'apps/web/src/link/escape.ts', before: null, content: 'escape' }] },
          root,
        ),
        /regular files/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('route matching keeps web and API route syntax separate', () => {
  assert.equal(matchesRoute('/shops/$id', '/shops/123', 'web'), true);
  assert.equal(matchesRoute('/shops/:id', '/shops/123', 'api'), true);
  assert.equal(matchesRoute('/admin/:id{[0-9]+}', '/admin/123', 'api'), true);
  assert.equal(matchesRoute('/admin/:id{[0-9]+}', '/admin/not-a-number', 'api'), false);
  assert.equal(matchesRoute('/shops/:id', '/shops/123', 'web'), false);
  assert.equal(matchesRoute('/shops/$id', '/shops/123', 'api'), false);
  assert.equal(matchesRoute('/shops/:id', '/shops/123/reviews', 'api'), false);
  assert.equal(matchesRoute('/auth/', '/auth', 'web'), true);
});
