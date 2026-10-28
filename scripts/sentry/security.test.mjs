import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedPath, marker, safeRoute, validateDispatch } from './common.mjs';
import { applyManifest, validateManifest } from './patch.mjs';
import { permitted } from './tool-policy.mjs';
import { matchesRoute } from './source-graph.mjs';

const payload = { sentryIssueId: '12345', sentryProject: 'koin-prod', sentryOrganization: 'bcsdlab' };
const config = { organization: 'bcsdlab', projects: ['koin-prod'] };
const event = { action: 'sentry-autofix', client_payload: payload };

test('dispatch accepts only the signed identity contract and manual ops inputs', () => {
  assert.deepEqual(validateDispatch(event, 'repository_dispatch', config), payload);
  assert.deepEqual(validateDispatch({ inputs: { sentryIssueId: '12345', sentryProject: 'koin-prod' } }, 'workflow_dispatch', config), payload);
  for (const patch of [{ sentryIssueId: 12345 }, { sentryIssueId: '00123' }, { sentryIssueId: '1\nrun' }, { sentryOrganization: 'other' }, { sentryProject: 'other' }, { prompt: 'execute this' }]) {
    assert.throws(() => validateDispatch({ ...event, client_payload: { ...payload, ...patch } }, 'repository_dispatch', config));
  }
  assert.throws(() => validateDispatch(event, 'pull_request', config));
  assert.equal(marker(payload), '<!-- sentry-autofix:bcsdlab:koin-prod:12345 -->');
});

test('canonical routes strip secrets and refuse external destinations', () => {
  assert.equal(safeRoute('https://koreatech.in/auth?token=secret#private', ['koreatech.in']), '/auth');
  for (const value of ['https://evil.example/auth', 'javascript:alert(1)', 'https://user:pass@koreatech.in/auth', 'https://koreatech.in//evil', 'https://koreatech.in/%2fsecret']) assert.equal(safeRoute(value, ['koreatech.in']), null);
});

test('patch scope excludes configuration, symlinks, generated files and oversized data', () => {
  assert.equal(allowedPath('apps/web/src/routes/shop.$id.tsx'), true);
  assert.equal(allowedPath('apps/api/src/auth.ts'), true);
  assert.equal(allowedPath('apps/api/src/db/schema.ts'), false);
  assert.equal(allowedPath('tests/sentry/regression.test.mjs'), true);
  for (const path of ['src/index.ts', 'workers/koin-api/src/index.ts', 'apps/web/src/../package.json', 'apps/web/src/.env', 'apps/web/src/generated/log.ts', 'apps/web/src/routeTree.gen.ts', 'apps/api/src/generated/schema.ts', 'apps/api/package.json', 'apps/sentry-automation/src/index.ts', '.github/workflows/run.yml', 'scripts/sentry/verify.mjs', 'pnpm-lock.yaml', 'tests/other.test.mjs', '/apps/web/src/index.ts', 'apps\\web\\src\\index.ts']) assert.equal(allowedPath(path), false, path);
  assert.throws(() => validateManifest({ version: 1, files: [{ path: 'apps/web/src/file.ts', before: null, content: 'x'.repeat(256001) }] }));
  assert.throws(() => validateManifest({ version: 1, files: Array.from({ length: 25 }, (_, index) => ({ path: `apps/api/src/${index}.ts`, before: null, content: '' })) }));
  assert.throws(() => validateManifest({ version: 1, files: [{ path: 'apps/web/src/a.ts', before: null, content: '' }, { path: 'apps/web/src/a.ts', before: null, content: '' }] }));
});

test('tool policy does not let diagnostic instructions grant execution or secret reads', () => {
  assert.equal(permitted('Read', 'sentry-input/diagnostics.json'), true);
  assert.equal(permitted('Edit', 'apps/web/src/utils/value.ts'), true);
  assert.equal(permitted('Edit', 'apps/api/src/auth.ts'), true);
  assert.equal(permitted('Read', 'apps/api/src/db/schema.ts'), true);
  assert.equal(permitted('Write', 'apps/api/src/db/schema.ts'), false);
  for (const [tool, path] of [['Bash', 'apps/web/src/a.ts'], ['Read', '.git/config'], ['Read', '/proc/self/environ'], ['Read', 'sentry-input/context.json'], ['Write', 'scripts/sentry/tool-policy.mjs'], ['Write', 'sentry-input/diagnostics.json'], ['Write', 'apps/sentry-automation/src/index.ts'], ['Read', 'src/index.ts'], ['WebFetch', 'apps/web/src/a.ts']]) assert.equal(permitted(tool, path), false);
});

test('independent application rejects changed baselines and symlink parents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentry-guard-'));
  try {
    await mkdir(join(root, 'apps/web/src'), { recursive: true });
    await writeFile(join(root, 'apps/web/src/a.ts'), 'existing');
    await assert.rejects(applyManifest({ version: 1, files: [{ path: 'apps/web/src/a.ts', before: null, content: 'overwrite' }] }, root), /Baseline mismatch/);
    await applyManifest({ version: 1, files: [{ path: 'apps/web/src/b.ts', before: null, content: 'export const b = 1;' }] }, root);
    assert.equal(await readFile(join(root, 'apps/web/src/b.ts'), 'utf8'), 'export const b = 1;');
    if (process.platform !== 'win32') {
      await symlink(tmpdir(), join(root, 'apps/web/src/link'));
      await assert.rejects(applyManifest({ version: 1, files: [{ path: 'apps/web/src/link/escape.ts', before: null, content: 'escape' }] }, root), /regular files/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
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
