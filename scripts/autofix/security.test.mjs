import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedPath } from './common.mjs';
import { applyManifest, validateManifest } from './patch.mjs';
import { matchesRoute } from './source-graph.mjs';

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
