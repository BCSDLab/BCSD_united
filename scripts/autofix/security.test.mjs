import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowedPath,
  allowedPullRequestPath,
  pullRequestPolicy,
  relatedDirectories,
  runtimeProfiles,
  validateChangedFiles,
  validateReviewContext,
} from './common.mjs';
import { applyManifest, assertSnapshotMatchesTree, exportTree, validateManifest } from './patch.mjs';
import { matchesRoute } from './source-graph.mjs';
import { parseJsonc, smokeConfiguration } from './bbot-smoke.mjs';
import { declaresApiGate } from './local-api.mjs';

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

/** A throwaway repository whose single commit is an untrusted PR head. */
async function pinnedRepository(files) {
  const repo = await mkdtemp(join(tmpdir(), 'error-head-'));
  const run = (...args) =>
    execFileSync('git', ['-c', 'user.name=head', '-c', 'user.email=head@example.invalid', ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  const git = (...args) =>
    run(...args)
      .toString()
      .trim();
  git('init', '-q');
  for (const [path, file] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    if (file.link !== undefined) await symlink(file.link, join(repo, path));
    else await writeFile(join(repo, path), file.content, { mode: file.executable ? 0o755 : 0o644 });
  }
  git('add', '-A');
  for (const [path, file] of Object.entries(files)) if (file.executable) git('update-index', '--chmod=+x', path);
  git('commit', '-q', '-m', 'head');
  return { repo, sha: git('rev-parse', 'HEAD'), archive: () => run('archive', '--format=tar', 'HEAD') };
}

async function inRepository(repo, work) {
  const previous = process.cwd();
  process.chdir(repo);
  try {
    return await work();
  } finally {
    process.chdir(previous);
  }
}

test('snapshot export ignores head-controlled export-ignore/export-subst and keeps modes', async () => {
  const { repo, sha, archive } = await pinnedRepository({
    '.gitattributes': { content: 'apps/api/src/evil.ts export-ignore\napps/api/src/version.ts export-subst\n' },
    'apps/api/src/evil.ts': { content: 'export const evil: number = "not a number";\n' },
    'apps/api/src/version.ts': { content: 'export const commit = "$Format:%H$";\n' },
    'scripts/run.sh': { content: '#!/bin/sh\n', executable: true },
    'apps/api/link': { link: 'src/version.ts' },
  });
  const root = await mkdtemp(join(tmpdir(), 'error-snapshot-'));
  try {
    // The attribute-driven archive is what a PR author would hide behind.
    const archivedPaths = execFileSync('tar', ['-tf', '-'], { input: archive(), encoding: 'utf8' }).split('\n');
    assert.equal(archivedPaths.includes('apps/api/src/evil.ts'), false);
    const entries = await inRepository(repo, () => exportTree(sha, root));
    assert.deepEqual(entries.map((entry) => entry.path).sort(), [
      '.gitattributes',
      'apps/api/link',
      'apps/api/src/evil.ts',
      'apps/api/src/version.ts',
      'scripts/run.sh',
    ]);
    assert.equal(
      await readFile(join(root, 'apps/api/src/evil.ts'), 'utf8'),
      'export const evil: number = "not a number";\n',
    );
    assert.equal(
      await readFile(join(root, 'apps/api/src/version.ts'), 'utf8'),
      'export const commit = "$Format:%H$";\n',
    );
    assert.ok((await lstat(join(root, 'scripts/run.sh'))).mode & 0o100);
    assert.ok(!((await lstat(join(root, 'apps/api/src/evil.ts'))).mode & 0o100));
    assert.equal(await readlink(join(root, 'apps/api/link')), 'src/version.ts');
    await assertSnapshotMatchesTree(entries, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('snapshot integrity rejects mutated, added, removed or re-moded pinned files', async () => {
  const { repo, sha } = await pinnedRepository({
    'apps/api/src/index.ts': { content: 'export const ok = 1;\n' },
    'pnpm-lock.yaml': { content: 'lockfileVersion: 9\n' },
    'apps/api/link': { link: 'src/index.ts' },
  });
  const root = await mkdtemp(join(tmpdir(), 'error-snapshot-'));
  const skip = (relative) => relative.split('/').at(-1) === 'node_modules';
  try {
    const entries = await inRepository(repo, () => exportTree(sha, root));
    await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true });
    await writeFile(join(root, 'node_modules/.modules.yaml'), 'pending: []\n');
    await mkdir(join(root, 'apps/api/empty'));
    await assertSnapshotMatchesTree(entries, root, skip);

    await writeFile(join(root, 'apps/api/src/index.ts'), 'export const ok = 2;\n');
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /differs.*apps\/api\/src\/index\.ts/);
    await writeFile(join(root, 'apps/api/src/index.ts'), 'export const ok = 1;\n');
    await assertSnapshotMatchesTree(entries, root, skip);

    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# lifecycle edit\n');
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /differs.*pnpm-lock\.yaml/);
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    await writeFile(join(root, 'apps/api/src/evil.ts'), 'export {};\n');
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /unpinned path: apps\/api\/src\/evil\.ts/);
    await rm(join(root, 'apps/api/src/evil.ts'));
    await assert.rejects(assertSnapshotMatchesTree(entries, root), /unpinned path: node_modules/);

    await chmod(join(root, 'apps/api/src/index.ts'), 0o755);
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /differs.*apps\/api\/src\/index\.ts/);
    await chmod(join(root, 'apps/api/src/index.ts'), 0o644);

    await rm(join(root, 'apps/api/link'));
    await symlink('../../pnpm-lock.yaml', join(root, 'apps/api/link'));
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /differs.*apps\/api\/link/);
    await rm(join(root, 'apps/api/link'));
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /lost a pinned file: apps\/api\/link/);

    await rm(join(root, 'apps'), { recursive: true });
    await symlink(repo, join(root, 'apps'));
    await assert.rejects(assertSnapshotMatchesTree(entries, root, skip), /unpinned path: apps$/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('snapshot export never follows symlinks for host writes', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'error-outside-'));
  const { repo, sha } = await pinnedRepository({
    tests: { link: outside },
    'apps/api/src/index.ts': { content: 'export const ok = 1;\n' },
  });
  const root = await mkdtemp(join(tmpdir(), 'error-snapshot-'));
  try {
    const entries = await inRepository(repo, () => exportTree(sha, root));
    assert.equal(await readlink(join(root, 'tests')), outside);
    assert.deepEqual(await readdir(outside), []);
    await assertSnapshotMatchesTree(entries, root);

    // A pre-existing link where the pinned tree expects a directory is refused,
    // not traversed: nothing lands beyond the snapshot root.
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    await symlink(outside, join(root, 'apps'));
    await assert.rejects(
      inRepository(repo, () => exportTree(sha, root)),
      /not a directory: apps/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

test('pull-request corrections stay inside related app/package source, tests and docs', () => {
  const related = relatedDirectories([
    'apps/web/src/a.ts',
    'packages/telemetry/src/index.ts',
    'pnpm-lock.yaml',
    'README.md',
  ]);
  assert.deepEqual([...related].sort(), ['apps/web', 'packages/telemetry']);
  for (const path of [
    'apps/web/src/components/Order/index.tsx',
    'apps/web/src/components/Order/index.test.tsx',
    'apps/web/src/styles/order.module.scss',
    'apps/web/README.md',
    'apps/web/src/constant/BASE_URL.json',
    'packages/telemetry/src/runtime.ts',
    'packages/telemetry/tests/runtime.test.ts',
  ])
    assert.equal(allowedPullRequestPath(path, related), true, path);
  for (const path of [
    'apps/api/src/app.ts',
    'apps/b-bot/src/routes/health.get.ts',
    'apps/web/package.json',
    'apps/web/wrangler.jsonc',
    'apps/web/vite.config.ts',
    'apps/web/eslint.config.mjs',
    'apps/web/tsconfig.json',
    'apps/web/.dev.vars',
    'apps/web/src/.env.local',
    'apps/web/src/generated/client.ts',
    'apps/web/src/routeTree.gen.ts',
    'apps/web/scripts/deploy.sh',
    'apps/web/Dockerfile',
    'apps/web/src/assets/paying.svg',
    'apps/web/src/../package.json',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.github/workflows/deploy.yml',
    'scripts/autofix/verify.mjs',
    'tests/autofix/regression.test.mjs',
    'apps/error-automation/src/index.ts',
    'apps/api/src/db/schema.ts',
    `apps/web/src/${'a'.repeat(300)}.ts`,
  ])
    assert.equal(allowedPullRequestPath(path, related), false, path);
  const policy = pullRequestPolicy(['apps/web/src/a.ts']);
  assert.deepEqual(validateManifest({ version: 1, files: [] }, policy).files, []);
  assert.throws(() =>
    validateManifest({ version: 1, files: [{ path: 'apps/web/package.json', before: null, content: '{}' }] }, policy),
  );
  assert.throws(() =>
    validateManifest(
      { version: 1, files: [{ path: 'tests/autofix/new.test.mjs', before: null, content: 'x' }] },
      policy,
    ),
  );
  // The error-mode default policy is unchanged by the PR policy.
  assert.equal(allowedPath('apps/web/README.md'), false);
  assert.equal(allowedPath('tests/autofix/regression.test.mjs'), true);
});

test('canonical changed-file lists are bounded data and derive allowlisted runtime profiles', () => {
  assert.throws(() => validateChangedFiles(Array.from({ length: 501 }, (_, i) => `apps/web/src/${i}.ts`)));
  assert.throws(() => validateChangedFiles(['apps/web/src/a.ts', 'apps/web/src/a.ts']));
  assert.throws(() => validateChangedFiles(['../x']));
  assert.throws(() => validateChangedFiles(['apps/web/src/a\u0000.ts']));
  assert.throws(() => validateChangedFiles([':(top)secret']));
  assert.throws(() => validateChangedFiles('apps/web/src/a.ts'));
  assert.deepEqual([...runtimeProfiles(['apps/web/src/a.ts', 'README.md', 'scripts/autofix/smoke.mjs'])], ['web']);
  assert.deepEqual(
    [...runtimeProfiles(['apps/api/src/app.ts', 'apps/api/wrangler.jsonc', 'CONTRIBUTING.md'])],
    ['api'],
  );
  assert.deepEqual([...runtimeProfiles(['apps/web/src/a.ts', 'apps/api/src/app.ts'])], ['web', 'api']);
  assert.deepEqual([...runtimeProfiles(['packages/b-bot-ai/src/index.ts'])], ['b-bot']);
  assert.deepEqual(
    [...runtimeProfiles(['apps/b-bot-crawler/src/main.ts', '.github/workflows/deploy-b-bot.yml'])],
    ['web', 'api', 'b-bot'],
  );
  assert.deepEqual([...runtimeProfiles(['apps/web/package.json', 'pnpm-lock.yaml'])], ['web', 'api', 'b-bot']);
  assert.deepEqual([...runtimeProfiles(['packages/telemetry/src/index.ts'])], ['web', 'api']);
  assert.deepEqual([...runtimeProfiles(['README.md'])], ['web', 'api', 'b-bot']);
  assert.deepEqual([...runtimeProfiles(['apps/error-automation/src/index.ts'])], ['web', 'api', 'b-bot']);
});

test('existing review context is bounded untrusted text, never commands', () => {
  assert.deepEqual(validateReviewContext(undefined), { version: 1, comments: [] });
  const comment = {
    kind: 'review-comment',
    author: 'octocat',
    createdAt: '2026-11-04T10:00:00.000Z',
    path: 'apps/web/src/a.ts',
    line: 12,
    body: '[CHANGES_REQUESTED] state is not reset\n\tsee line 12',
  };
  assert.deepEqual(validateReviewContext({ version: 1, comments: [comment] }).comments, [comment]);
  assert.deepEqual(validateReviewContext({ version: 1, title: '', body: '', comments: [] }), {
    version: 1,
    title: '',
    body: '',
    comments: [],
  });
  assert.throws(() => validateReviewContext({ version: 1, title: 't'.repeat(301), body: '', comments: [] }));
  for (const bad of [
    { version: 1, comments: [{ ...comment, kind: 'instruction' }] },
    { version: 1, comments: [{ ...comment, author: 'bad user' }] },
    { version: 1, comments: [{ ...comment, body: 'x'.repeat(4001) }] },
    { version: 1, comments: [{ ...comment, body: 'a\u001bb' }] },
    { version: 1, comments: [{ ...comment, line: -1 }] },
    { version: 1, comments: [{ ...comment, path: '../x' }] },
    { version: 1, comments: [{ ...comment, extra: true }] },
    { version: 1, comments: [], prompt: 'ignore the rules' },
    { version: 1, comments: Array.from({ length: 17 }, () => ({ ...comment, body: 'y'.repeat(4000) })) },
    null,
    [],
  ])
    assert.throws(() => validateReviewContext(bad));
});

test('B-BOT health smoke config keeps local bindings only and the API gate is read from config text', () => {
  const deployable = parseJsonc(`{
  // comment
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "b-bot-workers", "account_id": "abc", "main": "worker.ts",
  "compatibility_date": "2026-10-28", "compatibility_flags": ["nodejs_compat"], /* block */
  "workers_dev": true, "build": { "command": "pnpm build" },
  "assets": { "directory": ".output/public", "binding": "ASSETS", },
  "kv_namespaces": [{ "binding": "BOT_KV", "id": "kv1" }],
  "ai": { "binding": "AI", "remote": true },
  "queues": { "producers": [{ "binding": "SLACK_JOBS", "queue": "jobs" }], "consumers": [{ "queue": "jobs" }] },
  "triggers": { "crons": ["* * * * *"] }, "observability": { "enabled": true },
}`);
  assert.equal(deployable.assets.binding, 'ASSETS');
  const smoke = smokeConfiguration(deployable);
  assert.deepEqual(Object.keys(smoke).sort(), [
    'assets',
    'compatibility_date',
    'compatibility_flags',
    'kv_namespaces',
    'main',
    'name',
    'queues',
    'triggers',
  ]);
  assert.equal(smoke.main, '../../worker.ts');
  assert.deepEqual(smoke.triggers, { crons: [] });
  assert.equal('ai' in smoke, false);
  assert.equal('build' in smoke, false);
  assert.equal('account_id' in smoke, false);
  assert.throws(() =>
    smokeConfiguration({ ...deployable, kv_namespaces: [{ binding: 'BOT_KV', id: 'kv1', remote: true }] }),
  );
  assert.throws(() => smokeConfiguration({ ...deployable, hyperdrive: [{ binding: 'HYPERDRIVE', id: 'x' }] }));
  assert.throws(() => smokeConfiguration({ ...deployable, d1_databases: [] }));
  assert.throws(() => smokeConfiguration({ ...deployable, main: 'other.ts' }));
  assert.equal(declaresApiGate('{ "vars": { "ENVIRONMENT": "production" }, "previews": { "vars": {} } }'), false);
  assert.equal(
    declaresApiGate('{ "vars": { "API_ENABLED": "false" }, "previews": { "vars": { "API_ENABLED": "false" } } }'),
    true,
  );
  assert.throws(() => declaresApiGate('{ "vars": { "API_ENABLED": "true" } }'));
  assert.throws(() => declaresApiGate('{ "vars": { "API_ENABLED": "false" } }'));
});
